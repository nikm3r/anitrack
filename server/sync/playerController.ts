/**
 * playerController.ts — Player control for AniTrack SyncWatch
 * 
 * Based on Syncplay's VLC and MPV player implementations.
 * Key design principles from Syncplay:
 * - Poll every 100ms
 * - Extrapolate position forward based on time since last update
 * - VLC: TCP socket with line protocol (same as syncplay.lua)
 * - MPV: JSON IPC with observe_property for push events
 */

import net from "net";
import path from "path";
import fs from "fs";
import os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerStatus {
  position: number;    // extrapolated seconds
  paused: boolean;
  filename: string | null;
}

export interface IPlayerController {
  getStatus(): Promise<PlayerStatus | null>;
  getStoredPosition(): number;   // raw last-polled position (not extrapolated)
  getStoredPaused(): boolean;
  getLastPositionUpdate(): number;  // Date.now() of last position update
  seek(seconds: number): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setRate(rate: number): Promise<void>;
  isConnected(): boolean;
  disconnect(): void;
}

// ─── VLC Controller ──────────────────────────────────────────────────────────
// Communicates with syncwatch.lua via TCP. Protocol is line-delimited text.
// Polls every 100ms by sending ".". Extrapolates position when playing.

export class VlcController implements IPlayerController {
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Raw stored state
  private _position = 0;
  private _paused = true;
  private _filename: string | null = null;
  private _lastPositionUpdate = 0;
  private _lastPauseUpdate = 0;

  // VLC precision bug: track last two positions to detect duplicates
  private _prevPrevPosition = -2;
  private _prevPosition = -1;

  // VLC EOF detection threshold
  private readonly EOF_THRESHOLD = 2.0;
  private _duration: number | null = null;

  // Minimum position change to register (noise filter)
  private readonly MIN_POSITION_CHANGE = 0.05;

  constructor(private port: number) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.port, "127.0.0.1");
      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error("VLC connection timeout"));
      }, 3000);

      sock.on("connect", () => {
        clearTimeout(timeout);
        this.socket = sock;
        this.connected = true;
        this._startPolling();
        // Request duration and filepath on connect
        this._send("get-duration");
        this._send("get-filepath");
        resolve();
      });

      sock.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (t) this._handleLine(t);
        }
      });

      sock.on("error", (err) => {
        clearTimeout(timeout);
        this.connected = false;
        reject(err);
      });

      sock.on("close", () => {
        this.connected = false;
        this.socket = null;
        this._stopPolling();
      });
    });
  }

  private _handleLine(line: string) {
    // playstate: playing|paused|no-input
    if (line.startsWith("playstate: ")) {
      const state = line.slice("playstate: ".length).trim();
      if (state === "no-input") return;

      const nowPaused = state !== "playing";

      // VLC EOF bug: VLC reports "playing" but is actually at end
      // Detect: position stuck at same value near end of file
      if (!nowPaused && this._duration && this._duration > 2) {
        const nearEnd = (this._duration - this._position) < this.EOF_THRESHOLD;
        const positionStuck =
          this._position === this._prevPrevPosition &&
          this._position === this._prevPosition;
        if (nearEnd && positionStuck) {
          // Treat as paused (EOF)
          if (!this._paused) {
            this._paused = true;
            this._lastPauseUpdate = Date.now();
          }
          return;
        }
      }

      if (nowPaused !== this._paused) {
        this._paused = nowPaused;
        this._lastPauseUpdate = Date.now();
        if (!nowPaused) {
          // Just unpaused — update position timestamp
          this._lastPositionUpdate = Date.now();
        }
      }
      return;
    }

    // position: <secs>|no-input
    if (line.startsWith("position: ")) {
      const raw = line.slice("position: ".length).trim().replace(",", ".");
      if (raw === "no-input") return;
      const val = parseFloat(raw);
      if (isNaN(val)) return;

      // VLC precision bug: if position unchanged and not paused, ignore as duplicate
      // (VLC sometimes sends the same position twice due to timer precision)
      if (
        val === this._prevPosition &&
        val !== this._duration &&
        !this._paused
      ) {
        // It's a duplicate — extrapolate instead
        return;
      }

      // Track previous positions for EOF and duplicate detection
      this._prevPrevPosition = this._prevPosition;
      this._prevPosition = this._position;

      const newPos = Math.max(0, val);
      if (Math.abs(newPos - this._position) >= this.MIN_POSITION_CHANGE || this._lastPositionUpdate === 0) {
        this._position = newPos;
        this._lastPositionUpdate = Date.now();
      }
      return;
    }

    // duration: <secs>|no-input
    if (line.startsWith("duration: ")) {
      const raw = line.slice("duration: ".length).trim().replace(",", ".");
      if (raw === "no-input") return;
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) this._duration = val;
      return;
    }

    // filepath/filename
    if (line.startsWith("filepath: ") || line.startsWith("filename: ")) {
      const val = line.split(": ").slice(1).join(": ").trim();
      this._filename = (val && val !== "no-input") ? val : null;
      return;
    }

    // filepath changed — re-request duration
    if (line === "filepath-change-notification") {
      this._send("get-duration");
      this._send("get-filepath");
      this._prevPrevPosition = -2;
      this._prevPosition = -1;
      return;
    }
  }

  private _send(cmd: string): void {
    if (!this.socket || !this.connected) return;
    try { this.socket.write(cmd + "\n"); } catch {}
  }

  private _startPolling() {
    this._stopPolling();
    // Poll every 100ms like Syncplay
    this.pollTimer = setInterval(() => {
      if (this.connected) this._send(".");
    }, 100);
  }

  private _stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  isConnected(): boolean { return this.connected; }

  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }

  // Extrapolate position forward based on time since last update (Syncplay pattern)
  getCalculatedPosition(): number {
    if (this._lastPositionUpdate === 0) return 0;
    if (this._paused) return this._position;
    const elapsed = (Date.now() - this._lastPositionUpdate) / 1000;
    // Cap extrapolation at 2s to avoid large jumps on reconnect
    return this._position + Math.min(elapsed, 2.0);
  }

  async getStatus(): Promise<PlayerStatus | null> {
    if (!this.connected || this._lastPositionUpdate === 0) return null;
    return {
      position: this.getCalculatedPosition(),
      paused: this._paused,
      filename: this._filename,
    };
  }

  async seek(seconds: number): Promise<void> {
    const s = Math.max(0, seconds);
    // Use locale-aware radix character (VLC on some locales uses comma)
    const formatted = s.toString();
    this._send(`set-position: ${formatted}`);
    // Optimistically update local state
    this._position = s;
    this._prevPosition = s;
    this._prevPrevPosition = s;
    this._lastPositionUpdate = Date.now();
  }

  async setPaused(paused: boolean): Promise<void> {
    this._send(`set-playstate: ${paused ? "paused" : "playing"}`);
    this._paused = paused;
    this._lastPauseUpdate = Date.now();
    if (!paused) this._lastPositionUpdate = Date.now();
  }

  async setRate(rate: number): Promise<void> {
    this._send(`set-rate: ${rate.toFixed(2)}`);
  }

  async loadFile(filePath: string): Promise<void> {
    this._send(`load-file: ${filePath}`);
    // Reset position tracking for new file
    this._position = 0;
    this._prevPosition = -1;
    this._prevPrevPosition = -2;
    this._duration = null;
    this._lastPositionUpdate = 0;
  }

  disconnect(): void {
    this._stopPolling();
    this.connected = false;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}

// ─── MPV Controller ──────────────────────────────────────────────────────────
// Communicates with MPV via JSON IPC socket. Uses observe_property for
// real-time push events. Extrapolates position when playing.

export class MpvController implements IPlayerController {
  private socket: net.Socket | null = null;
  private connected = false;
  private requestId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";

  // Raw stored state from MPV events
  private _position = 0;
  private _paused = true;
  private _filename: string | null = null;
  private _lastPositionUpdate = 0;
  private _lastPauseUpdate = 0;
  private _fileLoaded = false;
  private _lastLoadedTime = 0;

  // MPV newfile ignore window (like Syncplay's MPV_NEWFILE_IGNORE_TIME = 1s)
  private readonly NEWFILE_IGNORE_TIME = 1000; // ms

  constructor(private socketPath: string) {}

  static getSocketPath(): string {
    if (process.platform === "win32") return "\\\\.\\pipe\\anitrack-mpv-sync";
    return path.join(os.tmpdir(), "anitrack-mpv.sock");
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error("MPV connection timeout"));
      }, 3000);

      this.socket.on("connect", () => {
        clearTimeout(timeout);
        this.connected = true;
        this._observeProperties();
        resolve();
      });

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (t) this._handleLine(t);
        }
      });

      this.socket.on("error", (err) => {
        clearTimeout(timeout);
        this.connected = false;
        reject(err);
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.socket = null;
        for (const { reject } of this.pending.values()) {
          reject(new Error("MPV socket closed"));
        }
        this.pending.clear();
      });
    });
  }

  private _handleLine(line: string) {
    try {
      const msg = JSON.parse(line);

      // Response to a command
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error === "success") resolve(msg.data);
        else reject(new Error(msg.error));
        return;
      }

      // Property change event
      if (msg.event === "property-change") {
        this._handlePropertyChange(msg.name, msg.data);
        return;
      }

      // File loaded event
      if (msg.event === "file-loaded") {
        this._fileLoaded = true;
        this._lastLoadedTime = Date.now();
        this._position = 0;
        this._lastPositionUpdate = Date.now();
        return;
      }

      // End of file event
      if (msg.event === "end-file") {
        this._fileLoaded = false;
        return;
      }
    } catch { /* ignore parse errors */ }
  }

  private _handlePropertyChange(name: string, data: any) {
    if (name === "time-pos") {
      if (data === null || data === undefined) return;
      const val = parseFloat(data);
      if (isNaN(val)) return;

      // Don't store position during newfile cooldown (like Syncplay)
      const sinceLoad = Date.now() - this._lastLoadedTime;
      if (this._lastLoadedTime > 0 && sinceLoad < this.NEWFILE_IGNORE_TIME) return;

      this._position = Math.max(0, val);
      this._lastPositionUpdate = Date.now();
    } else if (name === "pause") {
      if (data === null || data === undefined) return;
      const wasPaused = this._paused;
      this._paused = Boolean(data);
      this._lastPauseUpdate = Date.now();
      if (wasPaused && !this._paused) {
        // Just unpaused — refresh position timestamp
        this._lastPositionUpdate = Date.now();
      }
    } else if (name === "filename") {
      this._filename = data ?? null;
    } else if (name === "media-title") {
      if (!this._filename) this._filename = data ?? null;
    }
  }

  private _observeProperties() {
    // Observe key properties for real-time push events
    this._sendRaw({ command: ["observe_property", 1, "time-pos"] });
    this._sendRaw({ command: ["observe_property", 2, "pause"] });
    this._sendRaw({ command: ["observe_property", 3, "filename"] });
    this._sendRaw({ command: ["observe_property", 4, "media-title"] });
    // Subscribe to file-loaded and end-file events
    this._sendRaw({ command: ["observe_property", 5, "path"] });
  }

  private _sendRaw(obj: object): void {
    if (!this.socket || !this.connected) return;
    try { this.socket.write(JSON.stringify(obj) + "\n"); } catch {}
  }

  private _command(args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pending.set(id, { resolve, reject });
      this._sendRaw({ command: args, request_id: id });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("MPV command timeout"));
        }
      }, 2000);
    });
  }

  isConnected(): boolean { return this.connected; }
  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }

  // Extrapolate position forward (same as Syncplay's getCalculatedPosition)
  getCalculatedPosition(): number {
    if (this._lastPositionUpdate === 0) return 0;
    if (this._paused) return this._position;
    const elapsed = (Date.now() - this._lastPositionUpdate) / 1000;
    return this._position + Math.min(elapsed, 2.0);
  }

  async getStatus(): Promise<PlayerStatus | null> {
    if (!this.connected || this._lastPositionUpdate === 0) return null;
    return {
      position: this.getCalculatedPosition(),
      paused: this._paused,
      filename: this._filename,
    };
  }

  async seek(seconds: number): Promise<void> {
    const s = Math.max(0, seconds);
    await this._command(["set_property", "time-pos", s]);
    this._position = s;
    this._lastPositionUpdate = Date.now();
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this._paused === paused) return; // Don't send if already in that state
    await this._command(["set_property", "pause", paused]);
    this._paused = paused;
    this._lastPauseUpdate = Date.now();
    if (!paused) this._lastPositionUpdate = Date.now();
  }

  async setRate(rate: number): Promise<void> {
    await this._command(["set_property", "speed", rate]);
  }

  disconnect(): void {
    this.connected = false;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this.pending.clear();
  }
}

// ─── Controller manager ───────────────────────────────────────────────────────

let activeController: IPlayerController | null = null;
let activePlayerType: "mpv" | "vlc" | null = null;
let vlcPort: number | null = null;
let vlcFilePath: string | null = null;
let _gaveUp = false;
let _connectingPromise: Promise<IPlayerController | null> | null = null;

// Ready signal for VLC (blocks connection until lua interface is up)
let _vlcReadyResolve: (() => void) | null = null;
let _vlcReadyPromise: Promise<void> | null = null;

export function setActivePlayer(type: "mpv" | "vlc", port?: number, filePath?: string) {
  activePlayerType = type;
  if (type === "vlc" && port) vlcPort = port;
  if (type === "vlc" && filePath) vlcFilePath = filePath;
  activeController = null;
  _connectingPromise = null;
  // For VLC, block connection until lua signals ready
  _gaveUp = (type === "vlc");
  console.log(`[${type}] setActivePlayer: port=${port}, waiting for ${type === "vlc" ? "lua ready signal" : "IPC socket"}`);
}

export function clearActivePlayer() {
  activeController?.disconnect();
  activeController = null;
  activePlayerType = null;
  vlcPort = null;
  vlcFilePath = null;
  _gaveUp = false;
  _connectingPromise = null;
  _vlcReadyResolve = null;
  _vlcReadyPromise = null;
}

export function initVlcReadyPromise(): Promise<void> {
  _vlcReadyPromise = new Promise<void>((resolve) => { _vlcReadyResolve = resolve; });
  return _vlcReadyPromise;
}

export function signalVlcReady() {
  console.log("[vlc] lua interface ready — attempting connection");
  _connectingPromise = null;
  _gaveUp = false;
  _vlcReadyResolve?.();
}

export async function getController(): Promise<IPlayerController | null> {
  if (activeController?.isConnected()) return activeController;
  if (!activePlayerType) return null;
  if (_gaveUp) return null;
  if (_connectingPromise) return _connectingPromise;
  _connectingPromise = _doConnect().finally(() => { _connectingPromise = null; });
  return _connectingPromise;
}

async function _doConnect(): Promise<IPlayerController | null> {
  try {
    if (activePlayerType === "mpv") {
      const ctrl = new MpvController(MpvController.getSocketPath());
      await ctrl.connect();
      activeController = ctrl;
      console.log("[mpv] Connected via JSON IPC");
      return ctrl;
    }

    if (activePlayerType === "vlc" && vlcPort) {
      // Syncplay VLCClientFactory: initialDelay=0.3s, maxDelay=0.45s, maxRetries=50
      const MAX_RETRIES = 50;
      const INITIAL_DELAY = 300;
      const MAX_DELAY = 450;

      console.log(`[vlc] Attempting to connect on port ${vlcPort}...`);
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const ctrl = new VlcController(vlcPort);
          await ctrl.connect();
          activeController = ctrl;
          console.log(`[vlc] Connected on port ${vlcPort} (attempt ${attempt})`);
          // Load file if provided
          if (vlcFilePath) {
            console.log(`[vlc] Sending load-file: ${vlcFilePath}`);
            await ctrl.loadFile(vlcFilePath);
          }
          return ctrl;
        } catch (e) {
          if (attempt === 1 || attempt % 10 === 0) {
            console.log(`[vlc] Connect attempt ${attempt}/${MAX_RETRIES} failed: ${e instanceof Error ? e.message : e}`);
          }
          const delay = Math.min(INITIAL_DELAY * Math.pow(1.1, attempt - 1), MAX_DELAY);
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, delay));
        }
      }
      console.error(`[vlc] Failed to connect after ${MAX_RETRIES} attempts — giving up`);
      _gaveUp = true;
    }
  } catch (e) {
    console.error(`[${activePlayerType}] Connection error:`, e);
    activeController = null;
  }
  return null;
}

// ─── VLC lua install ──────────────────────────────────────────────────────────

export function getVlcIntfPaths(): { userPath: string } | null {
  const home = os.homedir();
  const plat = process.platform;
  if (plat === "linux")  return { userPath: path.join(home, ".local/share/vlc/lua/intf/") };
  if (plat === "darwin") return { userPath: path.join(home, "Library/Application Support/org.videolan.vlc/lua/intf/") };
  if (plat === "win32")  return { userPath: path.join(process.env.APPDATA || home, "VLC", "lua", "intf") };
  return null;
}

export function installVlcLua(resourcesPath: string, vlcExePath?: string): boolean {
  // Prefer syncwatch.lua, fall back to syncplay.lua
  let src = path.join(resourcesPath, "syncwatch.lua");
  let destName = "syncwatch.lua";
  if (!fs.existsSync(src)) {
    src = path.join(resourcesPath, "syncplay.lua");
    destName = "syncplay.lua";
  }
  if (!fs.existsSync(src)) {
    console.error(`[vlc] No lua interface file found in: ${resourcesPath}`);
    return false;
  }

  // Portable VLC
  if (vlcExePath?.toLowerCase().includes("portable")) {
    const portableIntf = path.join(path.dirname(vlcExePath), "App", "vlc", "lua", "intf");
    try {
      fs.mkdirSync(portableIntf, { recursive: true });
      fs.copyFileSync(src, path.join(portableIntf, destName));
      console.log(`[vlc] Installed ${destName} to portable path`);
      return true;
    } catch {}
  }

  const paths = getVlcIntfPaths();
  if (!paths) return false;

  let installed = false;

  // User path
  try {
    fs.mkdirSync(paths.userPath, { recursive: true });
    fs.copyFileSync(src, path.join(paths.userPath, destName));
    console.log(`[vlc] Installed ${destName} to user path: ${paths.userPath}`);
    installed = true;
  } catch (e) {
    console.error(`[vlc] Failed to install to user path: ${e}`);
  }

  // Windows: also try system path (VLC exe dir)
  if (process.platform === "win32" && vlcExePath) {
    const sysIntf = path.join(path.dirname(vlcExePath), "lua", "intf");
    try {
      fs.mkdirSync(sysIntf, { recursive: true });
      fs.copyFileSync(src, path.join(sysIntf, destName));
      console.log(`[vlc] Installed ${destName} to system path: ${sysIntf}`);
      installed = true;
    } catch (e) {
      console.error(`[vlc] Failed to install to system path: ${e}`);
    }
  }

  return installed;
}
