/**
 * SyncEngine — server-side sync logic for AniTrack
 *
 * Core logic ported directly from syncplay's client.py:
 *
 *   _determinePlayerStateChange(paused, position):
 *     pauseChange = playerPaused != paused AND globalPaused != paused
 *     seeked = playerDiff > SEEK_THRESHOLD AND globalDiff > SEEK_THRESHOLD
 *
 * The double-condition is the key insight: a state change only counts as
 * user-initiated if it differs from BOTH the previous player state AND the
 * global state. If we commanded a seek/pause, global state is already updated
 * to match, so globalState == newState, and the condition is false.
 * No suppress counters needed at all.
 *
 *   getPlayerPosition(): position += (now - lastUpdate) if playing
 *   getGlobalPosition(): position += (now - lastUpdate) if playing
 *
 * Both extrapolate forward from last known value — same as syncplay.
 */

import { io as ioClient, Socket } from "socket.io-client";
import { getController } from "./playerController.js";

// ─── Constants (mirrored from syncplay/constants.py) ──────────────────────────

const SEEK_THRESHOLD      = 1.0;   // constants.SEEK_THRESHOLD
const REWIND_THRESHOLD    = 4.0;   // constants.DEFAULT_REWIND_THRESHOLD
const SLOWDOWN_THRESHOLD  = 1.5;   // constants.DEFAULT_SLOWDOWN_KICKIN_THRESHOLD
const SLOWDOWN_RESET      = 0.1;   // constants.SLOWDOWN_RESET_THRESHOLD
const SLOWDOWN_RATE       = 0.95;  // constants.SLOWDOWN_RATE
const HEARTBEAT_INTERVAL  = 2000;
const PLAYER_POLL_INTERVAL = 100;  // constants.PLAYER_ASK_DELAY = 0.1s

// ─── Types ────────────────────────────────────────────────────────────────────

// Syncplay pattern: store raw value + timestamp, extrapolate on read
interface TimestampedState {
  position: number;
  paused: boolean;
  updatedAt: number; // 0 = never updated
}

interface GlobalState extends TimestampedState {
  setBy: string | null;
}

export interface SyncStatus {
  active: boolean;
  playerConnected: boolean;
  hubConnected: boolean;
  playerPosition: number;
  playerPaused: boolean;
  globalPosition: number;
  globalPaused: boolean;
  drift: number;
  synced: boolean;
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private hubSocket: Socket | null = null;
  private hubConnected = false;

  // Syncplay pattern: player and global are separate timestamped states
  private player: TimestampedState = { position: 0, paused: true, updatedAt: 0 };
  private global: GlobalState     = { position: 0, paused: true, updatedAt: 0, setBy: null };

  private lastSentState: { position: number; paused: boolean } | null = null;
  private speedSlowed = false;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  private username = "Guest";
  private roomId = "";
  private hubUrl = "https://anitrack-hub.onrender.com";
  private active = false;
  private onStatus: ((status: SyncStatus) => void) | null = null;

  join(username: string, roomId: string, hubUrl: string, onStatus?: (s: SyncStatus) => void) {
    this.username = username;
    this.roomId = roomId;
    this.hubUrl = hubUrl;
    this.onStatus = onStatus || null;
    this.active = true;
    this._connectHub();
    this._startPlayerPoll();
    this._startHeartbeat();
    console.log(`[sync] Joined room "${roomId}" as "${username}"`);
  }

  leave() {
    this.active = false;
    this._stopHeartbeat();
    this._stopPlayerPoll();
    this.hubSocket?.emit("leave-room", { roomId: this.roomId, username: this.username });
    this.hubSocket?.disconnect();
    this.hubSocket = null;
    console.log(`[sync] Left room "${this.roomId}"`);
  }

  isActive(): boolean  { return this.active; }
  isHubConnected(): boolean { return this.hubConnected; }
  getRoomId(): string  { return this.roomId; }
  getUsername(): string { return this.username; }

  getStatus(): SyncStatus {
    const globalPos = this._extrapolateGlobal();
    const playerPos = this._extrapolatePlayer();
    const drift = Math.abs(playerPos - globalPos);
    return {
      active: this.active,
      playerConnected: this.player.updatedAt > 0,
      hubConnected: this.hubConnected,
      playerPosition: playerPos,
      playerPaused: this.player.paused,
      globalPosition: globalPos,
      globalPaused: this.global.paused,
      drift,
      synced: drift < 2,
    };
  }

  // ── Player polling ──────────────────────────────────────────────────────────

  private _startPlayerPoll() {
    this._stopPlayerPoll();
    this.pollTimer = setInterval(() => this._pollPlayer(), PLAYER_POLL_INTERVAL);
  }

  private _stopPlayerPoll() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private async _pollPlayer() {
    if (!this.active) return;
    const ctrl = await getController();
    if (!ctrl) return;

    try {
      const status = await ctrl.getStatus();
      if (!status) return;

      const prevPosition = this._extrapolatePlayer();
      const prevPaused   = this.player.paused;

      // Update stored player state
      this.player.position  = status.position;
      this.player.paused    = status.paused;
      this.player.updatedAt = Date.now();

      if (!this.hubConnected) return;

      // ── Syncplay _determinePlayerStateChange ────────────────────────────────
      //
      // pauseChange = playerPaused != newPaused AND globalPaused != newPaused
      //
      // The double-condition means: only treat as user action if it differs
      // from BOTH what we had before AND what the global state says.
      // If we commanded a pause, global.paused is already updated to match,
      // so globalPaused == newPaused → false. No suppress counters needed.
      //
      // seeked = playerDiff > threshold AND globalDiff > threshold
      //
      // Same logic: if we commanded a seek, global.position is already updated,
      // so globalDiff is near 0 → false.

      const pauseChange = (prevPaused !== status.paused) && (this.global.paused !== status.paused);

      const playerDiff = Math.abs(prevPosition - status.position);
      const globalDiff = Math.abs(this._extrapolateGlobal() - status.position);
      const seeked = playerDiff > SEEK_THRESHOLD && globalDiff > SEEK_THRESHOLD;

      if (seeked) {
        console.log(`[sync] User seeked to ${status.position.toFixed(1)}s`);
        this._sendStateToHub(false);
        return;
      }

      if (pauseChange) {
        console.log(`[sync] Player ${status.paused ? "paused" : "unpaused"} by user at ${status.position.toFixed(1)}s`);
        this._sendStateToHub(false);
      }
    } catch {
      // Controller may have disconnected
    }
  }

  // ── Hub connection ──────────────────────────────────────────────────────────

  private _connectHub() {
    if (!this.active) return;

    const socket = ioClient(this.hubUrl, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
    });

    this.hubSocket = socket;

    socket.on("connect", () => {
      this.hubConnected = true;
      socket.emit("join-room", this.roomId, this.username);
      console.log(`[sync] Hub connected, joined room "${this.roomId}"`);
      this._emitStatus();
    });

    socket.on("reconnect", () => {
      console.log("[sync] Hub reconnected — rejoining room");
      socket.emit("join-room", this.roomId, this.username);
    });

    socket.on("disconnect", () => {
      this.hubConnected = false;
      this._emitStatus();
      if (this.player.updatedAt > 0) {
        console.log("[sync] Hub disconnected — pausing player");
        this._commandSetPaused(true);
      }
    });

    socket.on("state", ({ position, paused, doSeek, setBy }: any) => {
      const messageAge = 0.05;
      const adjustedPosition = paused ? position : position + messageAge;
      const wasPaused = this.global.paused;

      // Syncplay pattern: update global state first, then apply to player.
      // This is what makes the double-condition work: by the time the next
      // poll fires, global already reflects the commanded state.
      this.global.position  = adjustedPosition;
      this.global.paused    = paused;
      this.global.updatedAt = Date.now();
      this.global.setBy     = setBy;

      this._applyGlobalState(adjustedPosition, paused, doSeek, setBy, wasPaused);
    });

    socket.on("message", ({ text, system }: any) => {
      if (system && text?.includes("left the room")) {
        console.log(`[sync] ${text} — pausing player`);
        this._commandSetPaused(true);
      }
    });
  }

  // ── Apply incoming global state to player ───────────────────────────────────
  // Mirrors syncplay's _changePlayerStateAccordingToGlobalState

  private _applyGlobalState(
    position: number, paused: boolean,
    doSeek: boolean, setBy: string | null, wasPaused: boolean
  ) {
    if (this.player.updatedAt === 0) return; // player not ready yet

    const playerPos = this._extrapolatePlayer();
    const diff = playerPos - position;
    const pauseChanged = paused !== wasPaused || paused !== this.player.paused;

    // doSeek from a remote peer (syncplay's _serverSeeked)
    if (doSeek && setBy && setBy !== this.username) {
      console.log(`[sync] Remote seek by ${setBy} to ${position.toFixed(1)}s`);
      this._commandSeek(position);
      return;
    }

    // Rewind if we're too far ahead (syncplay's _rewindPlayerDueToTimeDifference)
    if (diff > REWIND_THRESHOLD) {
      console.log(`[sync] Rewind: ${diff.toFixed(1)}s ahead of ${setBy}`);
      this._commandSeek(position);
      return;
    }

    // Slow down if slightly ahead (syncplay's _slowDownToCoverTimeDifference)
    if (!paused && diff > SLOWDOWN_THRESHOLD && !this.speedSlowed) {
      console.log(`[sync] Slowing: ${diff.toFixed(1)}s ahead`);
      this.speedSlowed = true;
      this._commandSetRate(SLOWDOWN_RATE);
    } else if (Math.abs(diff) < SLOWDOWN_RESET && this.speedSlowed) {
      console.log("[sync] Back in sync — restoring speed");
      this.speedSlowed = false;
      this._commandSetRate(1.0);
    }

    // Pause/unpause from remote (syncplay's _serverPaused / _serverUnpaused)
    if (pauseChanged) {
      console.log(`[sync] Remote ${paused ? "pause" : "play"} by ${setBy}`);
      this._commandSetPaused(paused);
    }
  }

  // ── Player commands ─────────────────────────────────────────────────────────
  // After each command we update global state immediately — this is what makes
  // the double-condition check work correctly on the next poll.

  private async _commandSeek(seconds: number) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      // Update global position before seek so next poll's globalDiff ≈ 0
      this.global.position  = seconds;
      this.global.updatedAt = Date.now();
      await ctrl.seek(seconds);
      // ctrl.seek() also updates its internal stored position (see playerController)
      this.player.position  = seconds;
      this.player.updatedAt = Date.now();
    } catch (e) {
      console.error("[sync] seek failed:", e);
    }
  }

  private async _commandSetPaused(paused: boolean) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      // Update global paused before commanding so next poll's double-condition is false
      this.global.paused    = paused;
      this.global.updatedAt = Date.now();
      await ctrl.setPaused(paused);
      this.player.paused    = paused;
      this.player.updatedAt = Date.now();
    } catch (e) {
      console.error("[sync] setPaused failed:", e);
    }
  }

  private async _commandSetRate(rate: number) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      if (typeof (ctrl as any).setRate === "function") {
        await (ctrl as any).setRate(rate);
      }
    } catch (e) {
      console.error("[sync] setRate failed:", e);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  private _sendStateToHub(isHeartbeat: boolean) {
    if (!this.hubSocket?.connected || !this.active) return;

    const position = this._extrapolatePlayer();
    const paused   = this.player.paused;
    const prevPos  = this.lastSentState?.position ?? position;
    const globalPos = this._extrapolateGlobal();

    // doSeek: position jumped relative to both what we last sent AND global
    const doSeek = !isHeartbeat
      && Math.abs(prevPos - position) > SEEK_THRESHOLD
      && Math.abs(globalPos - position) > SEEK_THRESHOLD;

    this.hubSocket.emit("state", {
      roomId: this.roomId,
      position,
      paused,
      doSeek,
      setBy: this.username,
    });
    this.lastSentState = { position, paused };
  }

  private _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.hubConnected && this.player.updatedAt > 0) {
        this._sendStateToHub(true);
      }
    }, HEARTBEAT_INTERVAL);
  }

  private _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ── Extrapolation (syncplay's getPlayerPosition / getGlobalPosition) ─────────

  private _extrapolatePlayer(): number {
    if (!this.player.updatedAt) return 0;
    if (this.player.paused) return this.player.position;
    return this.player.position + (Date.now() - this.player.updatedAt) / 1000;
  }

  private _extrapolateGlobal(): number {
    if (!this.global.updatedAt) return 0;
    if (this.global.paused) return this.global.position;
    return this.global.position + (Date.now() - this.global.updatedAt) / 1000;
  }

  private _emitStatus() { this.onStatus?.(this.getStatus()); }
}

export const syncEngine = new SyncEngine();
