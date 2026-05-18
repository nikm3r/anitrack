/**
 * syncEngine.ts — AniTrack SyncWatch sync engine
 * 
 * Faithfully based on Syncplay 1.7.5 client.py sync algorithm:
 * 
 * _determinePlayerStateChange:
 *   pauseChange = playerPaused != paused AND globalPaused != paused
 *   seeked = abs(playerPos - pos) > SEEK_THRESHOLD AND abs(globalPos - pos) > SEEK_THRESHOLD
 *
 * _changePlayerStateAccordingToGlobalState (in order):
 *   1. doSeek flag → hard seek
 *   2. diff > rewindThreshold (4s, we are ahead) → rewind
 *   3. diff < -fastforwardBehindThreshold (-1.75s) for > threshold time → fastforward
 *   4. slowOnDesync → rate 0.95x when diff > 1.5s, reset when diff < 0.1s
 *   5. pauseChanged → apply pause/unpause
 *
 * SYNC_ON_PAUSE = true → seek to global position when applying remote pause
 *
 * Position extrapolation:
 *   getPlayerPosition() = storedPos + (now - lastUpdate) if playing
 *   getGlobalPosition() = storedPos + (now - lastUpdate) if playing
 */

import { Server as SocketIOServer } from "socket.io";
import { getController } from "./playerController.js";

// ─── Constants (from Syncplay constants.py) ───────────────────────────────────

const PLAYER_ASK_DELAY          = 0.1;    // 100ms — local poll interval
const SEEK_THRESHOLD            = 1.0;    // seconds — detect as seek vs drift
const REWIND_THRESHOLD          = 4.0;    // seconds ahead → hard rewind
const FASTFORWARD_BEHIND_THRESHOLD = 1.75; // seconds behind before FF starts
const FASTFORWARD_THRESHOLD     = 5.0;    // seconds behind → trigger fastforward
const FASTFORWARD_EXTRA_TIME    = 0.25;   // extra seconds added when fast-forwarding
const FASTFORWARD_RESET_THRESHOLD = 3.0;  // seconds to wait before re-checking FF
const SLOWDOWN_RATE             = 0.95;   // playback rate for soft correction
const SLOWDOWN_KICKIN_THRESHOLD = 1.5;    // seconds → start slowing down
const SLOWDOWN_RESET_THRESHOLD  = 0.1;    // seconds → restore normal rate
const PAUSE_DEBOUNCE            = 500;    // ms — ignore duplicate pause events
const BROADCAST_INTERVAL        = 500;    // ms — periodic state broadcast to hub
const SYNC_ON_PAUSE             = true;   // seek to global pos when applying remote pause

// ─── Types ────────────────────────────────────────────────────────────────────

interface GlobalState {
  position: number;     // raw position from hub (before extrapolation)
  paused: boolean;
  setBy: string;
  ts: number;           // local time when we received this
  doSeek?: boolean;
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
  private room = "";
  username = "";

  private socket: any = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  // ── Local player state (raw, not extrapolated) ────────────────────────────
  private _playerPosition = 0.0;
  private _playerPaused = true;
  private _lastPlayerUpdate: number | null = null;

  // ── Global state from hub (raw, not extrapolated) ─────────────────────────
  private _globalPosition = 0.0;
  private _globalPaused = true;
  private _lastGlobalUpdate: number | null = null;

  // ── Rate correction tracking ───────────────────────────────────────────────
  private _speedChanged = false;

  // ── Fastforward tracking ───────────────────────────────────────────────────
  private _behindFirstDetected: number | null = null;

  // ── Debounce / cooldowns ───────────────────────────────────────────────────
  private _lastPauseCommandAt = 0;
  private _lastBroadcastAt = 0;
  private _lastSeekAt = 0;

  // ── Peers ─────────────────────────────────────────────────────────────────
  private peers = new Map<string, PeerState>();

  constructor(private io: SocketIOServer) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  isActive(): boolean { return this.active; }
  getRoom(): string { return this.room; }
  getPeers(): PeerState[] { return [...this.peers.values()]; }

  // Extrapolated player position (Syncplay's getPlayerPosition())
  getPlayerPosition(): number {
    if (!this._lastPlayerUpdate) {
      return this._lastGlobalUpdate ? this.getGlobalPosition() : 0.0;
    }
    let pos = this._playerPosition;
    if (!this._playerPaused) {
      pos += (Date.now() - this._lastPlayerUpdate) / 1000;
    }
    return pos;
  }

  getPlayerPaused(): boolean {
    if (!this._lastPlayerUpdate) {
      return this._lastGlobalUpdate ? this.getGlobalPaused() : true;
    }
    return this._playerPaused;
  }

  // Extrapolated global position (Syncplay's getGlobalPosition())
  getGlobalPosition(): number {
    if (!this._lastGlobalUpdate) return 0.0;
    let pos = this._globalPosition;
    if (!this._globalPaused) {
      pos += (Date.now() - this._lastGlobalUpdate) / 1000;
    }
    return pos;
  }

  getGlobalPaused(): boolean {
    if (!this._lastGlobalUpdate) return true;
    return this._globalPaused;
  }

  async join(
    hubUrl: string,
    room: string,
    username: string,
  ) {
    if (this.active) await this.leave();

    this.room = room;
    this.username = username;

    console.log(`[sync] Joining room "${room}" as "${username}"`);

    const { io: sioClient } = await import("socket.io-client");
    this.socket = sioClient(hubUrl, { transports: ["websocket"], reconnection: true });

    this.socket.on("connect", () => {
      console.log(`[sync] Hub connected, joined room "${room}"`);
      this.socket.emit("join-room", room, username);
    });

    this.socket.on("disconnect", () => {
      console.log("[sync] Hub disconnected");
    });

    // Receive global state from other clients
    this.socket.on("state", (data: any) => this._onHubState(data));

    // Room membership updates
    this.socket.on("playlist-updated", (data: any) => {
      if (!data?.readyUsers) return;
      const now = Date.now();
      // Add new peers
      for (const user of Object.keys(data.readyUsers)) {
        if (user !== this.username && !this.peers.has(user)) {
          this.peers.set(user, { username: user, position: 0, paused: true, updatedAt: now });
        }
      }
      // Remove departed peers
      for (const user of [...this.peers.keys()]) {
        if (!(user in data.readyUsers)) this.peers.delete(user);
      }
      this._notifyPeers();
    });

    this.socket.on("host-changed", (data: any) => {
      console.log(`[sync] Host is now: ${data.host}`);
      this.io.emit("sync-host-changed", { host: data.host });
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
    this.peers.clear();

    // Reset sync state
    this._lastGlobalUpdate = null;
    this._lastPlayerUpdate = null;
    this._speedChanged = false;
    this._behindFirstDetected = null;

    // Restore normal playback rate if we changed it
    if (this._speedChanged) {
      const ctrl = await getController();
      if (ctrl) {
        try { await ctrl.setRate(1.0); } catch {}
      }
      this._speedChanged = false;
    }
  }

  // ─── Hub state received ────────────────────────────────────────────────────

  private _onHubState(data: any) {
    const now = Date.now();
    let position: number = data.position ?? 0;
    const paused: boolean = data.paused ?? true;
    const setBy: string = data.setBy ?? "";
    const doSeek: boolean = data.doSeek ?? false;

    // Compensate for message transit time (Syncplay's messageAge)
    // Hub stamps ts when it receives state; we add transit time to position
    const messageAge = data.ts ? Math.max(0, (now - data.ts) / 1000) : 0;
    if (!paused) position += messageAge;

    const prevGlobalPaused = this._globalPaused;
    this._globalPosition = position;
    this._globalPaused = paused;
    this._lastGlobalUpdate = now;

    // Don't apply our own state back to ourselves
    if (setBy === this.username) return;

    // Update peer tracking
    if (setBy) {
      this.peers.set(setBy, { username: setBy, position, paused, updatedAt: now });
      this._notifyPeers();
    }

    // Apply the global state to local player
    this._changePlayerStateAccordingToGlobalState(position, paused, doSeek, setBy, prevGlobalPaused);
  }

  // Core sync function — mirrors Syncplay's _changePlayerStateAccordingToGlobalState
  private async _changePlayerStateAccordingToGlobalState(
    position: number,
    paused: boolean,
    doSeek: boolean,
    setBy: string,
    prevGlobalPaused: boolean,
  ) {
    const ctrl = await getController();
    if (!ctrl) return;

    const status = await ctrl.getStatus();
    if (!status) {
      // First state update — init player position
      if (!this._lastPlayerUpdate) {
        try {
          await ctrl.seek(position);
          await ctrl.setPaused(paused);
          this._playerPosition = position;
          this._playerPaused = paused;
          this._lastPlayerUpdate = Date.now();
        } catch {}
      }
      return;
    }

    const now = Date.now();
    const playerPos = this.getPlayerPosition();
    const diff = playerPos - position; // positive = we are ahead, negative = we are behind
    const pauseChanged = paused !== prevGlobalPaused || paused !== this.getPlayerPaused();

    // ── 1. doSeek: explicit seek from remote ──────────────────────────────
    if (doSeek) {
      if (setBy !== this.username) {
        console.log(`[sync] Remote seek by ${setBy} → ${position.toFixed(2)}s`);
        try {
          await ctrl.seek(position);
          this._lastSeekAt = now;
          // Restore rate if we were slowing down
          if (this._speedChanged) {
            await ctrl.setRate(1.0);
            this._speedChanged = false;
          }
        } catch {}
      }
    }

    // ── 2. Rewind: we are too far ahead ───────────────────────────────────
    else if (diff > REWIND_THRESHOLD) {
      if (setBy !== this.username) {
        console.log(`[sync] Rewind: we are ${diff.toFixed(2)}s ahead of ${setBy} → seeking to ${position.toFixed(2)}s`);
        try {
          await ctrl.seek(position);
          this._lastSeekAt = now;
          if (this._speedChanged) {
            await ctrl.setRate(1.0);
            this._speedChanged = false;
          }
        } catch {}
      }
    }

    // ── 3. Fast forward: we are too far behind ────────────────────────────
    else if (diff < (FASTFORWARD_BEHIND_THRESHOLD * -1) && !doSeek) {
      if (this._behindFirstDetected === null) {
        this._behindFirstDetected = now;
      } else {
        const durationBehind = (now - this._behindFirstDetected) / 1000;
        if (
          durationBehind > (FASTFORWARD_THRESHOLD - FASTFORWARD_BEHIND_THRESHOLD) &&
          diff < (FASTFORWARD_THRESHOLD * -1)
        ) {
          if (setBy !== this.username) {
            const target = position + FASTFORWARD_EXTRA_TIME;
            console.log(`[sync] Fast forward: we are ${Math.abs(diff).toFixed(2)}s behind → seeking to ${target.toFixed(2)}s`);
            try {
              await ctrl.seek(target);
              this._lastSeekAt = now;
              this._behindFirstDetected = now + FASTFORWARD_RESET_THRESHOLD * 1000;
              if (this._speedChanged) {
                await ctrl.setRate(1.0);
                this._speedChanged = false;
              }
            } catch {}
          }
        }
      }
    } else {
      this._behindFirstDetected = null;
    }

    // ── 4. Slow down: small drift correction via rate ─────────────────────
    if (!doSeek && !paused) {
      await this._slowDownToCoverTimeDifference(diff, setBy);
    }

    // ── 5. Apply pause/unpause ────────────────────────────────────────────
    if (pauseChanged) {
      if (now - this._lastPauseCommandAt > PAUSE_DEBOUNCE) {
        if (paused) {
          // SYNC_ON_PAUSE: seek to global position when pausing
          if (SYNC_ON_PAUSE && setBy !== this.username) {
            try { await ctrl.seek(position); } catch {}
          }
          console.log(`[sync] Remote pause by ${setBy} at ${position.toFixed(2)}s`);
          try {
            await ctrl.setPaused(true);
            this._lastPauseCommandAt = now;
          } catch {}
        } else {
          console.log(`[sync] Remote unpause by ${setBy}`);
          try {
            await ctrl.setPaused(false);
            this._lastPauseCommandAt = now;
          } catch {}
        }
      }
    }
  }

  // Slow down / speed up to cover small time difference (Syncplay's _slowDownToCoverTimeDifference)
  private async _slowDownToCoverTimeDifference(diff: number, setBy: string) {
    if (setBy === this.username) return;
    const ctrl = await getController();
    if (!ctrl) return;

    const absDiff = Math.abs(diff);
    if (absDiff > SLOWDOWN_KICKIN_THRESHOLD && !this._speedChanged) {
      console.log(`[sync] Slowing down: drift=${diff.toFixed(2)}s`);
      try {
        await ctrl.setRate(SLOWDOWN_RATE);
        this._speedChanged = true;
      } catch {}
    } else if (this._speedChanged && absDiff < SLOWDOWN_RESET_THRESHOLD) {
      console.log(`[sync] Restoring normal rate: drift=${diff.toFixed(2)}s`);
      try {
        await ctrl.setRate(1.0);
        this._speedChanged = false;
      } catch {}
    }
  }

  // ─── Local player polling ─────────────────────────────────────────────────
  // Syncplay polls every 100ms (PLAYER_ASK_DELAY = 0.1s)

  private _startPolling() {
    this._stopPolling();
    this.pollTimer = setInterval(() => this._poll(), PLAYER_ASK_DELAY * 1000);
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
    const prevPaused = this._lastPlayerUpdate ? this._playerPaused : null;
    const prevPosition = this._playerPosition;

    this._playerPosition = status.position;
    this._playerPaused = status.paused;
    this._lastPlayerUpdate = now;

    // Emit status to UI clients
    this.io.emit("sync-status", {
      position: status.position,
      paused: status.paused,
      playerConnected: true,
    });

    // Detect local pause change → broadcast immediately
    if (prevPaused !== null && prevPaused !== status.paused) {
      if (now - this._lastPauseCommandAt > PAUSE_DEBOUNCE) {
        console.log(`[sync] Local ${status.paused ? "pause" : "play"} detected — broadcasting`);
        this._lastPauseCommandAt = now;
        this._broadcastState(status.position, status.paused, false);
      }
    }

    // Detect local seek (Syncplay's double-condition: diff > threshold vs BOTH player AND global)
    // playerDiff > SEEK_THRESHOLD AND globalDiff > SEEK_THRESHOLD
    if (prevPaused !== null) {
      const expectedDelta = PLAYER_ASK_DELAY * 1.5;
      const actualDelta = Math.abs(status.position - prevPosition);
      const wasPlaying = !status.paused;
      if (wasPlaying && actualDelta > expectedDelta + SEEK_THRESHOLD) {
        // Also check against global to avoid false positives on correction seeks
        const globalDiff = Math.abs(this.getGlobalPosition() - status.position);
        if (globalDiff > SEEK_THRESHOLD) {
          if (now - this._lastSeekAt > 1500) {
            console.log(`[sync] Local seek detected: ${prevPosition.toFixed(2)} → ${status.position.toFixed(2)}`);
            this._lastSeekAt = now;
            this._broadcastState(status.position, status.paused, true);
          }
        }
      }
    }
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  private _startBroadcasting() {
    this._stopBroadcasting();
    this.broadcastTimer = setInterval(async () => {
      if (!this.active) return;
      const ctrl = await getController();
      if (!ctrl) return;
      const status = await ctrl.getStatus();
      if (!status) return;
      const now = Date.now();
      if (now - this._lastBroadcastAt < BROADCAST_INTERVAL) return;
      this._lastBroadcastAt = now;
      this._broadcastState(status.position, status.paused, false);
    }, BROADCAST_INTERVAL);
  }

  private _stopBroadcasting() {
    if (this.broadcastTimer) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
  }

  private _broadcastState(position: number, paused: boolean, doSeek: boolean) {
    if (!this.active || !this.socket?.connected) return;
    const state: any = {
      roomId: this.room,
      position,
      paused,
      setBy: this.username,
      ts: Date.now(),
    };
    if (doSeek) state.doSeek = true;
    this.socket.emit("state", state);
    this._lastBroadcastAt = Date.now();
  }

  private _notifyPeers() {
    this.io.emit("sync-peers", [...this.peers.values()]);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _engine: SyncEngine | null = null;

export function getSyncEngine(io?: SocketIOServer): SyncEngine {
  if (!_engine) {
    if (!io) throw new Error("SyncEngine not initialized — pass io on first call");
    _engine = new SyncEngine(io);
  }
  return _engine;
}
