import { Server as SocketIOServer } from "socket.io";
import { getController } from "./playerController.js";

// ─── Constants (based on Syncplay's constants.py) ────────────────────────────

const PLAYER_POLL_INTERVAL     = 500;   // ms — same as Syncplay
const REWIND_THRESHOLD         = 4.0;   // seconds — hard seek back (Syncplay default: 4)
const FASTFORWARD_THRESHOLD    = 5.0;   // seconds — hard seek forward (Syncplay default: 5)
const SLOWDOWN_THRESHOLD       = 0.4;   // seconds — slow down playback rate
const SLOWDOWN_RATE            = 0.8;   // playback rate when slowing down
const SEEK_COOLDOWN            = 2000;  // ms — ignore drift after a seek
const PAUSE_DEBOUNCE           = 500;   // ms — ignore duplicate pause events
const POSITION_BROADCAST_INTERVAL = 500; // ms

// ─── Types ────────────────────────────────────────────────────────────────────

interface HubState {
  position: number;
  paused: boolean;
  setBy: string;
  ts: number;
}

interface PeerState {
  username: string;
  position: number;
  paused: boolean;
  updatedAt: number;
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private active = false;
  private isHost = false;
  private room = "";
  username = "";

  private socket: any = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  // Authoritative state from hub (after latency compensation)
  private hubState: HubState | null = null;

  // Last known local player state
  private lastLocalPosition = 0;
  private lastLocalPaused: boolean | null = null;
  private lastLocalTs = 0;

  // Cooldown/debounce timestamps
  private lastSeekAt = 0;
  private lastPauseCommandAt = 0;
  private lastBroadcastAt = 0;

  // Latency tracking (NTP-style)
  private latency = 0;
  private isSlowedDown = false;

  // Peers
  private peers = new Map<string, PeerState>();

  // Callbacks
  private onPeersChange?: (peers: PeerState[]) => void;
  private onHubEvent?: (event: string, data: any) => void;

  constructor(private io: SocketIOServer) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  isActive(): boolean { return this.active; }
  getRoom(): string { return this.room; }
  getPeers(): PeerState[] { return [...this.peers.values()]; }

  async join(
    hubUrl: string,
    room: string,
    username: string,
    onPeersChange?: (peers: PeerState[]) => void,
    onHubEvent?: (event: string, data: any) => void
  ) {
    if (this.active) await this.leave();

    this.room = room;
    this.username = username;
    this.onPeersChange = onPeersChange;
    this.onHubEvent = onHubEvent;

    console.log(`[sync] Joining room "${room}" as "${username}"`);

    const { io: sioClient } = await import("socket.io-client");
    this.socket = sioClient(hubUrl, { transports: ["websocket"], reconnection: true });

    this.socket.on("connect", () => {
      console.log(`[sync] Hub connected, joined room "${room}"`);
      this.socket.emit("join-room", room, username);
    });

    this.socket.on("disconnect", () => console.log("[sync] Hub disconnected"));

    this.socket.on("state", (data: any) => this._onHubState(data));

    this.socket.on("playlist-updated", (data: any) => {
      // Extract peers from readyUsers
      if (data?.readyUsers) {
        const now = Date.now();
        for (const [user] of Object.entries(data.readyUsers)) {
          if (user !== this.username && !this.peers.has(user)) {
            this.peers.set(user, { username: user, position: 0, paused: true, updatedAt: now });
          }
        }
        // Remove peers no longer in room
        for (const [user] of this.peers) {
          if (!(user in data.readyUsers)) this.peers.delete(user);
        }
        this._notifyPeers();
      }
      if (data?.host) {
        this.isHost = data.host === this.username;
        console.log(`[sync] Host is now: ${data.host} (me: ${this.isHost})`);
        this.io.emit("sync-host-changed", { host: data.host, isMe: this.isHost });
      }
    });

    this.socket.on("host-changed", (data: any) => {
      this.isHost = data.host === this.username;
      console.log(`[sync] Host is now: ${data.host} (me: ${this.isHost})`);
      this.io.emit("sync-host-changed", { host: data.host, isMe: this.isHost });
    });

    this.active = true;
    this._startPolling();
    this._startBroadcasting();
  }

  async leave() {
    console.log(`[sync] Left room "${this.room}"`);
    this.active = false;
    this._stopPolling();
    this._stopBroadcasting();
    this.socket?.disconnect();
    this.socket = null;
    this.room = "";
    this.hubState = null;
    this.peers.clear();
    this.lastSeekAt = 0;
    this.lastPauseCommandAt = 0;
    this.lastBroadcastAt = 0;
    this.lastLocalPaused = null;
    this.isSlowedDown = false;
    // Reset playback rate if slowed down
    const ctrl = await getController();
    if (ctrl && this.isSlowedDown) {
      try { (ctrl as any).setRate?.(1.0); } catch {}
    }
  }

  // ─── Hub state received ───────────────────────────────────────────────────

  private _onHubState(data: any) {
    const now = Date.now();
    const rtt = data.ts ? (now - data.ts) : (this.latency * 2);
    this.latency = Math.max(0, rtt / 2);

    // Compensate for transit time if playing
    let position = data.position ?? 0;
    if (!data.paused && data.ts) {
      position += this.latency / 1000;
    }

    const prev = this.hubState;
    this.hubState = {
      position,
      paused: data.paused ?? true,
      setBy: data.setBy ?? "",
      ts: now,
    };

    // Don't apply our own state back
    if (data.setBy === this.username) return;

    this._applyHubState(this.hubState, prev);
    this.onHubEvent?.("state", this.hubState);
  }

  private async _applyHubState(state: HubState, prev: HubState | null) {
    const ctrl = await getController();
    if (!ctrl) return;

    const status = await ctrl.getStatus();
    if (!status) return;

    const now = Date.now();

    // ── Pause/unpause (Syncplay double-condition check) ────────────────────
    // Only apply if BOTH: hub says pause changed AND local state doesn't match
    const hubPauseChanged = !prev || state.paused !== prev.paused;
    const localMismatch = status.paused !== state.paused;

    if (hubPauseChanged && localMismatch) {
      if (now - this.lastPauseCommandAt > PAUSE_DEBOUNCE) {
        console.log(`[sync] Applying remote ${state.paused ? "pause" : "play"} by ${state.setBy}`);
        await ctrl.setPaused(state.paused);
        this.lastPauseCommandAt = now;
        this.lastLocalPaused = state.paused;
      }
    }

    // ── Seek/drift correction (clients only, host is authoritative) ────────
    if (this.isHost) return;
    if (now - this.lastSeekAt < SEEK_COOLDOWN) return;
    if (state.paused) return; // Don't correct drift while paused

    const drift = state.position - status.position; // positive = we're behind

    if (Math.abs(drift) > FASTFORWARD_THRESHOLD || Math.abs(drift) > REWIND_THRESHOLD) {
      // Hard seek correction
      console.log(`[sync] Hard seek: drift=${drift.toFixed(2)}s → seeking to ${state.position.toFixed(2)}s`);
      await ctrl.seek(state.position);
      this.lastSeekAt = now;
      if (this.isSlowedDown) {
        try { (ctrl as any).setRate?.(1.0); } catch {}
        this.isSlowedDown = false;
      }
    } else if (Math.abs(drift) > SLOWDOWN_THRESHOLD && !this.isSlowedDown) {
      // Soft correction: slow down or speed up
      const rate = drift > 0 ? 1.2 : SLOWDOWN_RATE; // speed up if behind, slow down if ahead
      console.log(`[sync] Soft correction: drift=${drift.toFixed(2)}s, rate=${rate}`);
      try { (ctrl as any).setRate?.(rate); } catch {}
      this.isSlowedDown = true;
    } else if (Math.abs(drift) < 0.1 && this.isSlowedDown) {
      // Back in sync — restore rate
      try { (ctrl as any).setRate?.(1.0); } catch {}
      this.isSlowedDown = false;
    }
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private _startPolling() {
    this._stopPolling();
    this.pollTimer = setInterval(() => this._poll(), PLAYER_POLL_INTERVAL);
  }

  private _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private async _poll() {
    if (!this.active) return;
    const ctrl = await getController();
    if (!ctrl) return;
    const status = await ctrl.getStatus();
    if (!status) return;

    const now = Date.now();
    const prevPaused = this.lastLocalPaused;
    const prevPosition = this.lastLocalPosition;

    // Detect local pause/unpause — broadcast immediately
    if (prevPaused !== null && prevPaused !== status.paused) {
      if (now - this.lastPauseCommandAt > PAUSE_DEBOUNCE) {
        console.log(`[sync] Local ${status.paused ? "pause" : "play"} — broadcasting`);
        this.lastPauseCommandAt = now;
        this._broadcastState(status.position, status.paused);
      }
    }

    // Detect local seek — position jump larger than expected for poll interval
    const expectedDelta = (PLAYER_POLL_INTERVAL / 1000) * 1.5;
    const actualDelta = Math.abs(status.position - prevPosition);
    if (prevPaused === false && actualDelta > expectedDelta + 1.0) {
      if (now - this.lastSeekAt > SEEK_COOLDOWN) {
        console.log(`[sync] Local seek detected: ${prevPosition.toFixed(2)} → ${status.position.toFixed(2)}`);
        this.lastSeekAt = now;
        this._broadcastState(status.position, status.paused);
      }
    }

    this.lastLocalPosition = status.position;
    this.lastLocalPaused = status.paused;
    this.lastLocalTs = now;

    // Forward to UI
    this.io.emit("sync-status", { position: status.position, paused: status.paused });
  }

  // ─── Broadcasting ────────────────────────────────────────────────────────

  private _startBroadcasting() {
    this._stopBroadcasting();
    this.broadcastTimer = setInterval(async () => {
      if (!this.active) return;
      const ctrl = await getController();
      if (!ctrl) return;
      const status = await ctrl.getStatus();
      if (!status) return;
      const now = Date.now();
      if (now - this.lastBroadcastAt < POSITION_BROADCAST_INTERVAL) return;
      this.lastBroadcastAt = now;
      this._broadcastState(status.position, status.paused);
    }, POSITION_BROADCAST_INTERVAL);
  }

  private _stopBroadcasting() {
    if (this.broadcastTimer) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
  }

  private _broadcastState(position: number, paused: boolean) {
    if (!this.active || !this.socket?.connected) return;
    this.socket.emit("state", {
      roomId: this.room,
      position,
      paused,
      setBy: this.username,
      ts: Date.now(),
    });
  }

  private _notifyPeers() {
    this.onPeersChange?.([...this.peers.values()]);
    this.io.emit("sync-peers", [...this.peers.values()]);
  }
}

// Singleton
let _engine: SyncEngine | null = null;
export function getSyncEngine(io?: SocketIOServer): SyncEngine {
  if (!_engine) {
    if (!io) throw new Error("SyncEngine not initialized");
    _engine = new SyncEngine(io);
  }
  return _engine;
}
