import { Server as SocketIOServer, Socket } from "socket.io";
import { getController, IPlayerController, MpvController, VlcController } from "./playerController.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAYER_POLL_INTERVAL = 100;        // ms — how often we poll local player
const SOFT_DRIFT_THRESHOLD = 0.5;        // seconds — soft correction (adjust rate)
const HARD_DRIFT_THRESHOLD = 2.0;        // seconds — hard seek correction
const SEEK_COOLDOWN = 1500;              // ms — ignore drift checks after a seek
const PAUSE_DEBOUNCE = 300;              // ms — ignore duplicate pause events
const POSITION_BROADCAST_INTERVAL = 500; // ms — how often to broadcast our position to hub
const LATENCY_SAMPLES = 5;              // ping samples for offset estimation

// ─── Types ────────────────────────────────────────────────────────────────────

interface HubState {
  position: number;
  paused: boolean;
  setBy: string;
  ts: number; // unix ms when hub sent this
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

  private socket: import("socket.io-client").Socket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  // Hub state (last known authoritative state from hub)
  private hubState: HubState | null = null;

  // Timestamps for debouncing / cooldowns
  private lastSeekAt = 0;
  private lastPauseAt = 0;
  private lastLocalPauseState: boolean | null = null;
  private lastLocalPosition = 0;
  private lastBroadcastAt = 0;

  // Latency estimation
  private latency = 0; // ms

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
      this.socket!.emit("join", { room, username });
    });

    this.socket.on("disconnect", () => {
      console.log(`[sync] Hub disconnected`);
    });

    this.socket.on("state", (data: any) => this._onHubState(data));
    this.socket.on("peers", (data: any) => this._onPeersList(data));
    this.socket.on("peer-update", (data: any) => this._onPeerUpdate(data));
    this.socket.on("peer-left", (data: any) => {
      this.peers.delete(data.username);
      this._notifyPeers();
    });
    this.socket.on("host-changed", (data: any) => {
      this.isHost = data.host === this.username;
      console.log(`[sync] Host is now: ${data.host} (me: ${this.isHost})`);
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
    this.lastPauseAt = 0;
    this.lastLocalPauseState = null;
    this.lastBroadcastAt = 0;
  }

  // Called when local user seeks (from playback UI or direct control)
  onLocalSeek(position: number) {
    if (!this.active) return;
    this.lastSeekAt = Date.now();
    this._broadcastState({ position, paused: this.lastLocalPauseState ?? true });
  }

  // Called when local user pauses/unpauses
  onLocalPause(paused: boolean) {
    if (!this.active) return;
    const now = Date.now();
    if (Math.abs(now - this.lastPauseAt) < PAUSE_DEBOUNCE) return;
    this.lastPauseAt = now;
    this._broadcastState({ position: this.lastLocalPosition, paused });
  }

  // ─── Hub events ─────────────────────────────────────────────────────────────

  private _onHubState(data: any) {
    const now = Date.now();

    // Estimate network latency from round-trip if hub sends timestamps
    const latency = data.ts ? Math.max(0, (now - data.ts) / 2) : this.latency;
    this.latency = latency;

    const state: HubState = {
      position: data.position ?? 0,
      paused: data.paused ?? true,
      setBy: data.setBy ?? "",
      ts: data.ts ?? now,
    };

    // Compensate for transit time if playing
    if (!state.paused && data.ts) {
      const transitSeconds = latency / 1000;
      state.position = state.position + transitSeconds;
    }

    const prev = this.hubState;
    this.hubState = state;

    // If we set this state ourselves, don't apply it back (feedback loop prevention)
    if (state.setBy === this.username) return;

    this._applyHubState(state, prev);
    this.onHubEvent?.("state", state);
  }

  private async _applyHubState(state: HubState, prev: HubState | null) {
    const ctrl = await getController();
    if (!ctrl) return;

    const now = Date.now();
    const status = await ctrl.getStatus();
    if (!status) return;

    // Pause state changed
    const pauseChanged = !prev || state.paused !== prev.paused;
    if (pauseChanged) {
      console.log(`[sync] Remote ${state.paused ? "pause" : "play"} by ${state.setBy}`);
      // Debounce: if we just changed pause state ourselves, skip
      if (now - this.lastPauseAt > PAUSE_DEBOUNCE) {
        await ctrl.setPaused(state.paused);
        this.lastPauseAt = now;
        this.lastLocalPauseState = state.paused;
      }
    }

    // Position changed — only apply if we're a client (host is authoritative)
    if (!this.isHost) {
      if (now - this.lastSeekAt < SEEK_COOLDOWN) return;

      const drift = Math.abs(status.position - state.position);
      if (drift > HARD_DRIFT_THRESHOLD) {
        console.log(`[sync] Hard seek correction: drift=${drift.toFixed(2)}s → ${state.position.toFixed(2)}s`);
        await ctrl.seek(state.position);
        this.lastSeekAt = now;
      } else if (drift > SOFT_DRIFT_THRESHOLD && !state.paused) {
        // Soft correction: nudge position slightly
        const target = state.position + (this.latency / 1000);
        console.log(`[sync] Soft correction: drift=${drift.toFixed(2)}s`);
        await ctrl.seek(target);
        this.lastSeekAt = now;
      }
    }
  }

  private _onPeersList(data: any) {
    this.peers.clear();
    if (Array.isArray(data)) {
      for (const p of data) {
        if (p.username !== this.username) {
          this.peers.set(p.username, { username: p.username, position: p.position ?? 0, paused: p.paused ?? true, updatedAt: Date.now() });
        }
        if (p.isHost) {
          this.isHost = p.username === this.username;
        }
      }
    }
    this._notifyPeers();
  }

  private _onPeerUpdate(data: any) {
    if (data.username === this.username) return;
    this.peers.set(data.username, { username: data.username, position: data.position ?? 0, paused: data.paused ?? true, updatedAt: Date.now() });
    this._notifyPeers();
  }

  private _notifyPeers() {
    this.onPeersChange?.([...this.peers.values()]);
    // Forward to socket clients (UI)
    this.io.emit("sync-peers", [...this.peers.values()]);
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  private async _broadcastState(override?: { position: number; paused: boolean }) {
    if (!this.active || !this.socket?.connected) return;
    const ctrl = await getController();
    if (!ctrl) return;

    let position = override?.position ?? this.lastLocalPosition;
    let paused = override?.paused ?? (this.lastLocalPauseState ?? true);

    if (!override) {
      const status = await ctrl.getStatus();
      if (status) { position = status.position; paused = status.paused; }
    }

    this.socket.emit("state", { position, paused, setBy: this.username, ts: Date.now() });
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private _startPolling() {
    this._stopPolling();
    this.pollTimer = setInterval(() => this._poll(), PLAYER_POLL_INTERVAL);
  }

  private _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

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
      this.lastLocalPosition = status.position;
      this.lastLocalPauseState = status.paused;
      this.socket?.emit("state", { position: status.position, paused: status.paused, setBy: this.username, ts: now });
    }, POSITION_BROADCAST_INTERVAL);
  }

  private _stopBroadcasting() {
    if (this.broadcastTimer) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
  }

  private async _poll() {
    if (!this.active) return;
    const ctrl = await getController();
    if (!ctrl) return;
    const status = await ctrl.getStatus();
    if (!status) return;

    const prevPaused = this.lastLocalPauseState;
    const prevPos = this.lastLocalPosition;

    this.lastLocalPosition = status.position;
    this.lastLocalPauseState = status.paused;

    // Detect local pause/unpause and broadcast to hub
    if (prevPaused !== null && prevPaused !== status.paused) {
      const now = Date.now();
      if (now - this.lastPauseAt > PAUSE_DEBOUNCE) {
        console.log(`[sync] Local ${status.paused ? "pause" : "play"} detected — broadcasting`);
        this.lastPauseAt = now;
        await this._broadcastState({ position: status.position, paused: status.paused });
      }
    }

    // Detect local seek (large position jump) and broadcast
    const posDelta = Math.abs(status.position - prevPos);
    const expectedDelta = PLAYER_POLL_INTERVAL / 1000 + 0.1;
    if (!status.paused && posDelta > expectedDelta * 3 && Date.now() - this.lastSeekAt > SEEK_COOLDOWN) {
      console.log(`[sync] Local seek detected: ${prevPos.toFixed(2)} → ${status.position.toFixed(2)}`);
      this.lastSeekAt = Date.now();
      await this._broadcastState({ position: status.position, paused: status.paused });
    }

    // Forward status to UI clients
    this.io.emit("sync-status", { position: status.position, paused: status.paused });
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
