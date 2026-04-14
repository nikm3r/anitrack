import net from "net";
import path from "path";
import fs from "fs";
import os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerStatus {
  position: number;
  paused: boolean;
  filename: string | null;
}

export interface IPlayerController {
  getStatus(): Promise<PlayerStatus | null>;
  seek(seconds: number): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  isConnected(): boolean;
  disconnect(): void;
}

// ─── MPV Controller ───────────────────────────────────────────────────────────
// Uses MPV's JSON IPC. observe_property gives us push events on every change
// so we never need to poll — exactly how syncplay's mpv.py works via python-mpv-jsonipc.

export class MpvController implements IPlayerController {
  private socket: net.Socket | null = null;
  private connected = false;
  private requestId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";
  private observers = new Map<string, (val: any) => void>();

  // Syncplay pattern: store raw values + timestamp separately.
  // getStatus() extrapolates position forward when playing,
  // mirroring syncplay's getPlayerPosition(): position += (now - lastUpdate).
  private _position = 0;
  private _paused = true;
  private _filename: string | null = null;
  private _lastPositionUpdate = 0;
  private _lastPauseUpdate = 0;

  constructor(private socketPath: string) {}

  static getSocketPath(): string {
    if (process.platform === "win32") return "\\\\.\\pipe\\anitrack-mpv-sync";
    return path.join(os.tmpdir(), "anitrack-mpv.sock");
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);
      this.socket.on("connect", () => { this.connected = true; this._observeProperties(); resolve(); });
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) { if (line.trim()) this._handleLine(line.trim()); }
      });
      this.socket.on("error", (err) => { this.connected = false; reject(err); });
      this.socket.on("close", () => {
        this.connected = false; this.socket = null;
        for (const { reject } of this.pending.values()) reject(new Error("MPV socket closed"));
        this.pending.clear();
      });
      setTimeout(() => { if (!this.connected) reject(new Error("MPV connection timeout")); }, 3000);
    });
  }

  private _handleLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error === "success") resolve(msg.data); else reject(new Error(msg.error));
        return;
      }
      if (msg.event === "property-change") {
        const handler = this.observers.get(msg.name);
        if (handler) handler(msg.data);
      }
    } catch { /* ignore parse errors */ }
  }

  private _observeProperties() {
    this._sendRaw({ command: ["observe_property", 1, "time-pos"] });
    this._sendRaw({ command: ["observe_property", 2, "pause"] });
    this._sendRaw({ command: ["observe_property", 3, "filename"] });

    this.observers.set("time-pos", (val) => {
      if (val !== null && val !== undefined) {
        this._position = val;
        this._lastPositionUpdate = Date.now();
      }
    });
    this.observers.set("pause", (val) => {
      if (val !== null && val !== undefined) {
        this._paused = val;
        this._lastPauseUpdate = Date.now();
        // Reset position timestamp on unpause so extrapolation starts from now
        if (!val) this._lastPositionUpdate = Date.now();
      }
    });
    this.observers.set("filename", (val) => { this._filename = val ?? null; });
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("MPV command timeout")); }
      }, 2000);
    });
  }

  isConnected(): boolean { return this.connected; }

  async getStatus(): Promise<PlayerStatus | null> {
    if (!this.connected || this._lastPositionUpdate === 0) return null;
    const extrapolated = this._paused
      ? this._position
      : this._position + (Date.now() - this._lastPositionUpdate) / 1000;
    return { position: extrapolated, paused: this._paused, filename: this._filename };
  }

  // Exposed for syncEngine's double-condition check (syncplay pattern)
  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }
  getLastPauseUpdate(): number { return this._lastPauseUpdate; }

  async seek(seconds: number): Promise<void> {
    await this._command(["set_property", "time-pos", seconds]);
    // Syncplay pattern: update stored state immediately after commanding so
    // the next poll's double-condition check won't re-broadcast it as user action
    this._position = seconds;
    this._lastPositionUpdate = Date.now();
  }

  async setPaused(paused: boolean): Promise<void> {
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
  }
}

// ─── VLC Controller ───────────────────────────────────────────────────────────
// Talks to the syncplay.lua TCP interface. Sends "." every 200ms to poll
// state — same as syncplay's askForStatus() pattern.

export class VlcController implements IPlayerController {
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = "";
  private _position = 0;
  private _paused = true;
  private _filename: string | null = null;
  private _lastPositionUpdate = 0;
  private _lastPauseUpdate = 0;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private port: number) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.port, "127.0.0.1");
      this.socket.on("connect", () => { this.connected = true; this._startPolling(); resolve(); });
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) { const t = line.trim(); if (t) this._handleLine(t); }
      });
      this.socket.on("error", (err) => { this.connected = false; reject(err); });
      this.socket.on("close", () => { this.connected = false; this.socket = null; this._stopPolling(); });
      setTimeout(() => { if (!this.connected) reject(new Error("VLC connection timeout")); }, 3000);
    });
  }

  private _handleLine(line: string) {
    if (line.startsWith("playstate: ")) {
      const state = line.slice("playstate: ".length).trim();
      if (state !== "no-input") {
        const nowPaused = state !== "playing";
        if (nowPaused !== this._paused) this._lastPauseUpdate = Date.now();
        this._paused = nowPaused;
        if (!this._paused) this._lastPositionUpdate = Date.now();
      }
    } else if (line.startsWith("position: ")) {
      const raw = line.slice("position: ".length).trim().replace(",", ".");
      const val = parseFloat(raw);
      if (!isNaN(val) && raw !== "no-input") {
        this._position = val % 604800; // strip titlemultiplier
        this._lastPositionUpdate = Date.now();
      }
    } else if (line.startsWith("filepath: ") || line.startsWith("filename: ")) {
      const val = line.split(": ").slice(1).join(": ").trim();
      this._filename = val && val !== "no-input" ? val : null;
    }
  }

  private _send(cmd: string): void {
    if (!this.socket || !this.connected) return;
    try { this.socket.write(cmd + "\n"); } catch {}
  }

  private _startPolling() {
    this._pollTimer = setInterval(() => { if (this.connected) this._send("."); }, 200);
  }

  private _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  isConnected(): boolean { return this.connected; }

  async getStatus(): Promise<PlayerStatus | null> {
    if (!this.connected || this._lastPositionUpdate === 0) return null;
    const extrapolated = this._paused
      ? this._position
      : this._position + (Date.now() - this._lastPositionUpdate) / 1000;
    return { position: extrapolated, paused: this._paused, filename: this._filename };
  }

  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }
  getLastPauseUpdate(): number { return this._lastPauseUpdate; }

  async seek(seconds: number): Promise<void> {
    this._send(`set-position: ${seconds}`);
    this._position = seconds;
    this._lastPositionUpdate = Date.now();
  }

  async setPaused(paused: boolean): Promise<void> {
    this._send(`set-playstate: ${paused ? "paused" : "playing"}`);
    this._paused = paused;
    this._lastPauseUpdate = Date.now();
    if (!paused) this._lastPositionUpdate = Date.now();
  }

  async setRate(rate: number): Promise<void> {
    this._send(`set-rate: ${rate}`);
  }

  async loadFile(filePath: string): Promise<void> {
    this._send(`load-file: ${filePath}`);
  }

  disconnect(): void {
    this._stopPolling();
    this.connected = false;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}

// ─── Controller manager ───────────────────────────────────────────────────────

let activeController: IPlayerController | null = null;
let activePlayerType: "mpv" | "vlc" | null = null;
let vlcPort: number | null = null;
let _vlcReadyResolve: (() => void) | null = null;
let _vlcReadyPromise: Promise<void> | null = null;

let vlcFilePath: string | null = null;

export function setActivePlayer(type: "mpv" | "vlc", port?: number, filePath?: string) {
  activePlayerType = type;
  if (type === "vlc" && port) vlcPort = port;
  if (type === "vlc" && filePath) vlcFilePath = filePath;
  activeController = null;
  _connectingPromise = null;
  // For VLC, block getController() until signalVlcReady() fires.
  // This prevents the retry loop from exhausting itself before VLC is ready.
  _gaveUp = type === "vlc";
  console.log(`[vlc] setActivePlayer: type=${type}, port=${port}, waiting for lua ready signal`);
}

export function clearActivePlayer() {
  activeController?.disconnect();
  activeController = null;
  activePlayerType = null;
  vlcPort = null;
  _vlcReadyResolve = null;
  _vlcReadyPromise = null;
  _connectingPromise = null;
}

// Called by playback.ts when VLC's stderr emits the "Hosting Syncplay" line.
// Syncplay pattern: don't attempt TCP connect until the lua interface says it's listening.
export function signalVlcReady() {
  console.log("[vlc] lua interface ready — attempting connection");
  _connectingPromise = null;
  _gaveUp = false; // now allow getController() to connect
  _vlcReadyResolve?.();
}

export function initVlcReadyPromise(): Promise<void> {
  _vlcReadyPromise = new Promise<void>((resolve) => { _vlcReadyResolve = resolve; });
  return _vlcReadyPromise;
}

// Singleton connection promise — prevents parallel retry loops when poll fires every 100ms
let _connectingPromise: Promise<IPlayerController | null> | null = null;
let _gaveUp = false;

export async function getController(): Promise<IPlayerController | null> {
  if (activeController?.isConnected()) return activeController;
  if (!activePlayerType) return null;
  if (_gaveUp) {
    // Only log once
    return null;
  }
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
      return ctrl;
    }

    if (activePlayerType === "vlc" && vlcPort) {
      // Syncplay VLCClientFactory: initialDelay=0.3s, maxDelay=0.45s, maxRetries=50
      // We do NOT wait for the ready promise here — signalVlcReady() resets
      // _connectingPromise so a fresh _doConnect starts after the signal fires.
      // This avoids the race where _doConnect is suspended inside _connectingPromise
      // and can't be restarted when the signal arrives.
      console.log(`[vlc] Attempting to connect on port ${vlcPort}...`);
      const MAX_RETRIES = 50;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const ctrl = new VlcController(vlcPort);
          await ctrl.connect();
          activeController = ctrl;
          console.log(`[vlc] Connected on port ${vlcPort} (attempt ${attempt})`);
          // Send the file via load-file command, exactly as syncplay does
          if (vlcFilePath) {
            console.log(`[vlc] Sending load-file: ${vlcFilePath}`);
            await ctrl.loadFile(vlcFilePath);
          }
          return ctrl;
        } catch (e) {
          if (attempt === 1 || attempt % 10 === 0) {
            console.log(`[vlc] Connect attempt ${attempt}/${MAX_RETRIES} on port ${vlcPort} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 400));
        }
      }
      console.error(`[vlc] Failed to connect after ${MAX_RETRIES} attempts on port ${vlcPort} — giving up until next launch`);
      _gaveUp = true;
      // Emit an event so playback.ts can relaunch with file as direct arg
      if (vlcFilePath) {
        console.warn(`[vlc] lua interface failed — file was not loaded. User should close and reopen.`);
      }
    }
  } catch {
    activeController = null;
  }
  return null;
}

// ─── VLC lua intf setup ───────────────────────────────────────────────────────

export function getVlcIntfPaths(): { intfPath: string; userPath: string } | null {
  const home = os.homedir();
  const plat = process.platform;
  if (plat === "linux") return { intfPath: "/usr/lib/vlc/lua/intf/", userPath: path.join(home, ".local/share/vlc/lua/intf/") };
  if (plat === "darwin") return { intfPath: "/Applications/VLC.app/Contents/MacOS/share/lua/intf/", userPath: path.join(home, "Library/Application Support/org.videolan.vlc/lua/intf/") };
  if (plat === "win32") return { intfPath: "", userPath: path.join(process.env.APPDATA || home, "VLC", "lua", "intf") };
  return null;
}

export function installVlcLua(resourcesPath: string, vlcExePath?: string): boolean {
  const src = path.join(resourcesPath, "syncplay.lua");
  if (!fs.existsSync(src)) { console.error(`[vlc] syncplay.lua not found at: ${src}`); return false; }

  if (vlcExePath?.toLowerCase().includes("portable")) {
    const portableIntf = path.join(path.dirname(vlcExePath), "App", "vlc", "lua", "intf");
    try { fs.mkdirSync(portableIntf, { recursive: true }); fs.copyFileSync(src, path.join(portableIntf, "syncplay.lua")); return true; } catch {}
  }

  const paths = getVlcIntfPaths();
  if (!paths) return false;

  let installed = false;

  // Install to user path
  try {
    fs.mkdirSync(paths.userPath, { recursive: true });
    fs.copyFileSync(src, path.join(paths.userPath, "syncplay.lua"));
    console.log(`[vlc] Installed syncplay.lua to user path: ${paths.userPath}`);
    installed = true;
  } catch (e) { console.error(`[vlc] Failed to install to user path: ${e}`); }

  // On Windows also install to VLC system lua/intf dir alongside the exe
  // VLC 3.x checks this location first
  if (process.platform === "win32" && vlcExePath) {
    const sysIntf = path.join(path.dirname(vlcExePath), "lua", "intf");
    try {
      fs.mkdirSync(sysIntf, { recursive: true });
      fs.copyFileSync(src, path.join(sysIntf, "syncplay.lua"));
      console.log(`[vlc] Installed syncplay.lua to system path: ${sysIntf}`);
      installed = true;
    } catch (e) { console.error(`[vlc] Failed to install to system path: ${e}`); }
  }

  return installed;
}
