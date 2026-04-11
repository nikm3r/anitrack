/**
 * SyncEngine — server-side sync logic for AniTrack
 */

import { io as ioClient, Socket } from "socket.io-client";
import { getController, type IPlayerController } from "./playerController.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SEEK_THRESHOLD      = 1.0;
const REWIND_THRESHOLD    = 4.0;
const SLOWDOWN_THRESHOLD  = 1.5;
const SLOWDOWN_RESET      = 0.1;
const SLOWDOWN_RATE       = 0.95;
const HEARTBEAT_INTERVAL  = 2000;
const PLAYER_POLL_INTERVAL = 150;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlayerState {
  position: number;
  paused: boolean;
  updatedAt: number;
}

interface GlobalState {
  position: number;
  paused: boolean;
  updatedAt: number;
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

  private player: PlayerState = { position: 0, paused: true, updatedAt: 0 };
  private global: GlobalState = { position: 0, paused: true, updatedAt: 0, setBy: null };
  private lastSentState: { position: number; paused: boolean } | null = null;
  private lastPlayerPosition: number = 0;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private speedSlowed = false;

  // FIX: Use counters instead of booleans for suppress flags.
  //      A single boolean was lost if two commands fired in quick succession —
  //      the second command consumed the flag meant for the first event echo.
  private suppressSeekCount = 0;
  private suppressPauseCount = 0;

  private username = "Guest";
  private roomId = "";
  private hubUrl = "https://anitrack-hub.onrender.com";
  private active = false;

  private onStatus: ((status: SyncStatus) => void) | null = null;

  constructor() {}

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

  isActive(): boolean { return this.active; }
  isHubConnected(): boolean { return this.hubConnected; }
  getRoomId(): string { return this.roomId; }
  getUsername(): string { return this.username; }

  getStatus(): SyncStatus {
    const globalPos = this._extrapolateGlobal();
    const playerPos = this._extrapolatePlayer();
    const diff = Math.abs(playerPos - globalPos);
    return {
      active: this.active,
      playerConnected: this.player.updatedAt > 0,
      hubConnected: this.hubConnected,
      playerPosition: playerPos,
      playerPaused: this.player.paused,
      globalPosition: globalPos,
      globalPaused: this.global.paused,
      drift: diff,
      synced: diff < 2,
    };
  }

  private _startPlayerPoll() {
    this._stopPlayerPoll();
    this.pollTimer = setInterval(() => this._pollPlayer(), PLAYER_POLL_INTERVAL);
  }

  private _stopPlayerPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _pollPlayer() {
    if (!this.active) return;

    const ctrl = await getController();
    if (!ctrl) return;

    try {
      const status = await ctrl.getStatus();
      if (!status) return;

      const now = Date.now();
      const prevPaused = this.player.paused;
      const prevPosition = this.player.position;

      this.player.position = status.position;
      this.player.paused = status.paused;
      this.player.updatedAt = now;

      // FIX: Use counter — decrement instead of just clearing the flag.
      //      This handles rapid back-to-back seek commands correctly.
      if (this.suppressSeekCount > 0) {
        this.suppressSeekCount--;
        this.lastPlayerPosition = status.position;
        return;
      }

      const expectedPos = prevPosition + (this.player.paused ? 0 : PLAYER_POLL_INTERVAL / 1000);
      const jumped = Math.abs(status.position - expectedPos) > 2.0 && this.lastPlayerPosition !== 0;
      this.lastPlayerPosition = status.position;

      if (jumped && this.hubConnected) {
        console.log(`[sync] User seeked to ${status.position.toFixed(1)}s`);
        this._sendStateToHub(false);
        return;
      }

      // FIX: Use counter for pause suppress as well.
      if (this.suppressPauseCount > 0) {
        this.suppressPauseCount--;
        return;
      }
      if (status.paused !== prevPaused && this.hubConnected) {
        console.log(`[sync] Player ${status.paused ? "paused" : "unpaused"} by user at ${status.position.toFixed(1)}s`);
        this._sendStateToHub(false);
      }
    } catch {
      // Controller may have disconnected
    }
  }

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

    socket.on("state", ({ position, paused, doSeek, setBy, ignoringOnTheFly }: any) => {
      const now = Date.now();
      const messageAge = 0.05;
      const adjustedPosition = paused ? position : position + messageAge;

      const wasPaused = this.global.paused;
      this.global.position = adjustedPosition;
      this.global.paused = paused;
      this.global.updatedAt = now;
      this.global.setBy = setBy;

      this._applyGlobalState(adjustedPosition, paused, doSeek, setBy, wasPaused);
    });

    socket.on("message", ({ text, system }: any) => {
      if (system && text?.includes("left the room")) {
        console.log(`[sync] ${text} — pausing player`);
        this._commandSetPaused(true);
      }
    });
  }

  private _applyGlobalState(
    position: number,
    paused: boolean,
    doSeek: boolean,
    setBy: string | null,
    wasPaused: boolean
  ) {
    if (this.player.updatedAt === 0) return;

    const playerPos = this._extrapolatePlayer();
    const diff = playerPos - position;
    const pauseChanged = paused !== wasPaused || paused !== this.player.paused;

    if (doSeek && setBy && setBy !== this.username) {
      console.log(`[sync] Remote seek by ${setBy} to ${position.toFixed(1)}s`);
      this._commandSeek(position);
      return;
    }

    if (diff > REWIND_THRESHOLD) {
      console.log(`[sync] Rewind: ${diff.toFixed(1)}s ahead`);
      this._commandSeek(position);
      return;
    }

    if (!paused && diff > SLOWDOWN_THRESHOLD && !this.speedSlowed) {
      console.log(`[sync] Slowing down: ${diff.toFixed(1)}s ahead`);
      this.speedSlowed = true;
      this._commandSetRate(SLOWDOWN_RATE);
    } else if (Math.abs(diff) < SLOWDOWN_RESET && this.speedSlowed) {
      console.log("[sync] Back in sync, restoring speed");
      this.speedSlowed = false;
      this._commandSetRate(1.0);
    }

    if (pauseChanged) {
      console.log(`[sync] Remote ${paused ? "pause" : "play"} by ${setBy}`);
      this._commandSetPaused(paused);
    }
  }

  private async _commandSeek(seconds: number) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      this.suppressSeekCount++; // FIX: increment counter, not set boolean
      await ctrl.seek(seconds);
      this.player.position = seconds;
      this.player.updatedAt = Date.now();
    } catch (e) {
      this.suppressSeekCount = Math.max(0, this.suppressSeekCount - 1); // FIX: roll back on failure
      console.error("[sync] seek failed:", e);
    }
  }

  private async _commandSetPaused(paused: boolean) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      this.suppressPauseCount++; // FIX: increment counter
      await ctrl.setPaused(paused);
      this.player.paused = paused;
      this.player.updatedAt = Date.now();
    } catch (e) {
      this.suppressPauseCount = Math.max(0, this.suppressPauseCount - 1); // FIX: roll back on failure
      console.error("[sync] setPaused failed:", e);
    }
  }

  private async _commandSetRate(rate: number) {
    const ctrl = await getController();
    if (!ctrl) return;
    try {
      if (typeof (ctrl as any).setRate === "function") {
        await (ctrl as any).setRate(rate);
      } else {
        await (ctrl as any)._command(["set_property", "speed", rate]);
      }
    } catch (e) {
      console.error("[sync] setRate failed:", e);
    }
  }

  private _sendStateToHub(isHeartbeat: boolean) {
    if (!this.hubSocket?.connected || !this.active) return;

    const position = this._extrapolatePlayer();
    const paused = this.player.paused;

    const prevPos = this.lastSentState?.position ?? position;
    const globalPos = this._extrapolateGlobal();
    const playerDiff = Math.abs(prevPos - position);
    const globalDiff = Math.abs(globalPos - position);
    const doSeek = !isHeartbeat && playerDiff > SEEK_THRESHOLD && globalDiff > SEEK_THRESHOLD;

    const payload: any = {
      roomId: this.roomId,
      position,
      paused,
      doSeek,
      setBy: this.username,
    };

    this.hubSocket.emit("state", payload);
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

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

  private _emitStatus() {
    this.onStatus?.(this.getStatus());
  }
}

export const syncEngine = new SyncEngine();
