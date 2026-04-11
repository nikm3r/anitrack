import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { startQueueWorker, stopQueueWorker } from "./syncQueue.js";
import { getDb } from "./db.js";
import animeRouter from "./routes/anime.js";
import syncRouter from "./routes/sync.js";
import episodesRouter from "./routes/episodes.js";
import settingsRouter from "./routes/settings.js";
import trackerRouter from "./routes/tracker.js";
import trackerImportRouter from "./routes/tracker-import.js";
import filesRouter from "./routes/files.js";
import playbackRouter from "./routes/playback.js";
import torrentsRouter from "./routes/torrents.js";
import browseRouter from "./routes/browse.js";
import malAuthRouter from "./routes/mal-auth.js";

const IS_PROD = process.env.NODE_ENV === "production";
const PORT = parseInt(process.env.SERVER_PORT ?? "3000", 10);

const app = express();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000", "file://"],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  },
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.startsWith("http://localhost") || origin === "file://") {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"));
    }
  },
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  (req as express.Request & { io: SocketIOServer }).io = io;
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// NOTE: /api/proxy-image has been removed from here.
// FIX: There were two proxy-image implementations — this one (no disk cache)
//      and one in tracker-import.ts (with disk cache). Removed the inferior
//      duplicate. The canonical endpoint is now /api/tracker/proxy-image.
// If any frontend code calls /api/proxy-image, update it to /api/tracker/proxy-image.

app.use("/api/anime", animeRouter);
app.use("/api/sync", syncRouter);
app.use("/api/anime/:animeId/episodes", episodesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/tracker", trackerRouter);
app.use("/api/tracker", trackerImportRouter);
app.use("/api/files", filesRouter);
app.use("/api/playback", playbackRouter);
app.use("/api/torrents", torrentsRouter);
app.use("/api/browse", browseRouter);
app.use("/api/mal", malAuthRouter);

app.use("/api/*", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

if (IS_PROD) {
  const distPath = path.join(__dirname, "..", "renderer");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
}

io.on("connection", (socket) => {
  console.log("[socket] Client connected:", socket.id);
  socket.on("disconnect", () => console.log("[socket] Client disconnected:", socket.id));
  socket.on("subscribe:anime", (id: number) => socket.join(`anime:${id}`));
  socket.on("unsubscribe:anime", (id: number) => socket.leave(`anime:${id}`));
});

try { getDb(); } catch (err) {
  console.error("[server] DB init failed:", err);
  process.exit(1);
}

startQueueWorker(getDb());
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] AniTrack running on http://127.0.0.1:${PORT}`);
});

declare global {
  namespace Express {
    interface Request { io: SocketIOServer; }
  }
}

export { io };
