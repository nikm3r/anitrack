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

export class MpvController implements IPlayerController {
  private socket: net.Socket | null = null;
  private connected = false;
  private requestId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";
  private observers = new Map<string, (val: any) => void>();

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
      this.socket.on("connect", () => {
        this.connected = true;
        this._observeProperties();
        resolve();
      });
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) { if (line.trim()) this._handleLine(line.trim()); }
      });
      this.socket.on("error", (err) => { this.connected = false; reject(err); });
      this.socket.on("close", () => {
        this.connected = false;
        this.socket = null;
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
        const prev = this._paused;
        this._paused = val;
        this._lastPauseUpdate = Date.now();
        if (prev !== val && !val) this._lastPositionUpdate = Date.now();
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
    return { position: this._position, paused: this._paused, filename: this._filename };
  }

  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }
  getLastPauseUpdate(): number { return this._lastPauseUpdate; }

  async seek(seconds: number): Promise<void> {
    await this._command(["set_property", "time-pos", seconds]);
  }

  async setPaused(paused: boolean): Promise<void> {
    await this._command(["set_property", "pause", paused]);
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
// Talks to syncwatch.lua TCP interface via the same protocol as syncplay.lua.
// Sends "." polls every 500ms to get state updates.

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

  // Debounce: ignore position updates that are too small (noise)
  private readonly POSITION_MIN_CHANGE = 0.05; // seconds

  constructor(private port: number) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.port, "127.0.0.1");
      sock.on("connect", () => {
        this.socket = sock;
        this.connected = true;
        this._startPolling();
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
      sock.on("error", (err) => { this.connected = false; reject(err); });
      sock.on("close", () => {
        this.connected = false;
        this.socket = null;
        this._stopPolling();
      });
      setTimeout(() => { if (!this.connected) { sock.destroy(); reject(new Error("VLC connection timeout")); } }, 3000);
    });
  }

  private _handleLine(line: string) {
    if (line.startsWith("playstate: ")) {
      const state = line.slice("playstate: ".length).trim();
      if (state === "no-input") return;
      const nowPaused = state !== "playing";
      if (nowPaused !== this._paused) {
        this._paused = nowPaused;
        this._lastPauseUpdate = Date.now();
        if (!nowPaused) this._lastPositionUpdate = Date.now();
      }
    } else if (line.startsWith("position: ")) {
      const raw = line.slice("position: ".length).trim().replace(",", ".");
      if (raw === "no-input") return;
      const val = parseFloat(raw);
      if (isNaN(val)) return;
      // Wrap-around from title multiplier (604800 = 1 week in seconds)
      const cleaned = val % 604800;
      if (Math.abs(cleaned - this._position) < this.POSITION_MIN_CHANGE) return;
      this._position = cleaned;
      this._lastPositionUpdate = Date.now();
    } else if (line.startsWith("filepath: ") || line.startsWith("filename: ")) {
      const val = line.split(": ").slice(1).join(": ").trim();
      this._filename = (val && val !== "no-input") ? val : null;
    }
  }

  private _send(cmd: string): void {
    if (!this.socket || !this.connected) return;
    try { this.socket.write(cmd + "\n"); } catch {}
  }

  private _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      if (this.connected) this._send(".");
    }, 500);
  }

  private _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  isConnected(): boolean { return this.connected; }

  async getStatus(): Promise<PlayerStatus | null> {
    if (!this.connected || this._lastPositionUpdate === 0) return null;
    return { position: this._position, paused: this._paused, filename: this._filename };
  }

  getStoredPosition(): number { return this._position; }
  getStoredPaused(): boolean { return this._paused; }
  getLastPositionUpdate(): number { return this._lastPositionUpdate; }
  getLastPauseUpdate(): number { return this._lastPauseUpdate; }

  async seek(seconds: number): Promise<void> {
    this._send(`set-position: ${seconds}`);
    // Optimistically update local position to reduce bounce
    this._position = seconds;
    this._lastPositionUpdate = Date.now();
  }

  async setPaused(paused: boolean): Promise<void> {
    this._send(`set-playstate: ${paused ? "paused" : "playing"}`);
    this._paused = paused;
    this._lastPauseUpdate = Date.now();
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
let vlcFilePath: string | null = null;
let _vlcReadyResolve: (() => void) | null = null;
let _vlcReadyPromise: Promise<void> | null = null;
let _connectingPromise: Promise<IPlayerController | null> | null = null;
let _gaveUp = false;

export function setActivePlayer(type: "mpv" | "vlc", port?: number, filePath?: string) {
  activePlayerType = type;
  if (type === "vlc" && port) vlcPort = port;
  if (type === "vlc" && filePath) vlcFilePath = filePath;
  activeController = null;
  _connectingPromise = null;
  // Block connections until lua signals ready
  _gaveUp = type === "vlc";
  console.log(`[vlc] setActivePlayer: type=${type}, port=${port}, waiting for lua ready signal`);
}

export function clearActivePlayer() {
  activeController?.disconnect();
  activeController = null;
  activePlayerType = null;
  vlcPort = null;
  vlcFilePath = null;
  _vlcReadyResolve = null;
  _vlcReadyPromise = null;
  _connectingPromise = null;
  _gaveUp = false;
}

export function signalVlcReady() {
  console.log("[vlc] lua interface ready — attempting connection");
  _connectingPromise = null;
  _gaveUp = false;
  _vlcReadyResolve?.();
}

export function initVlcReadyPromise(): Promise<void> {
  _vlcReadyPromise = new Promise<void>((resolve) => { _vlcReadyResolve = resolve; });
  return _vlcReadyPromise;
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
      const MAX_RETRIES = 50;
      const RETRY_DELAY = 400;
      console.log(`[vlc] Attempting to connect on port ${vlcPort}...`);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const ctrl = new VlcController(vlcPort);
          await ctrl.connect();
          activeController = ctrl;
          console.log(`[vlc] Connected on port ${vlcPort} (attempt ${attempt})`);
          if (vlcFilePath) {
            console.log(`[vlc] Sending load-file: ${vlcFilePath}`);
            await ctrl.loadFile(vlcFilePath);
          }
          return ctrl;
        } catch (e) {
          if (attempt === 1 || attempt % 10 === 0) {
            console.log(`[vlc] Connect attempt ${attempt}/${MAX_RETRIES} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }

      console.error(`[vlc] Failed to connect after ${MAX_RETRIES} attempts — giving up`);
      _gaveUp = true;
    }
  } catch {
    activeController = null;
  }
  return null;
}

// ─── VLC lua intf install ─────────────────────────────────────────────────────

export function getVlcIntfPaths(): { userPath: string } | null {
  const home = os.homedir();
  const plat = process.platform;
  if (plat === "linux")  return { userPath: path.join(home, ".local/share/vlc/lua/intf/") };
  if (plat === "darwin") return { userPath: path.join(home, "Library/Application Support/org.videolan.vlc/lua/intf/") };
  if (plat === "win32")  return { userPath: path.join(process.env.APPDATA || home, "VLC", "lua", "intf") };
  return null;
}

export function installVlcLua(resourcesPath: string, vlcExePath?: string): boolean {
  // Prefer syncwatch.lua (our custom interface), fall back to syncplay.lua
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

  // Windows system path (VLC exe dir)
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
