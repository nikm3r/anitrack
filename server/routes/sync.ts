import { Router, Request, Response } from "express";
import { getSyncEngine } from "../sync/syncEngine.js";
import { getDb } from "../db.js";

const router = Router();

// POST /api/sync/join
router.post("/join", async (req: Request, res: Response) => {
  const { roomId, username } = req.body;
  if (!roomId || !username) {
    res.status(400).json({ error: "roomId and username are required" });
    return;
  }

  const db = getDb();
  const hubUrlRow = db.prepare("SELECT value FROM settings WHERE key = 'hub_url'").get() as { value: string } | undefined;
  const hubUrl = hubUrlRow?.value || "https://anitrack-hub.onrender.com";

  const engine = getSyncEngine();
  await engine.join(hubUrl, roomId, username);

  res.json({ ok: true, roomId, username, hubUrl });
});

// POST /api/sync/leave
router.post("/leave", async (_req: Request, res: Response) => {
  const engine = getSyncEngine();
  await engine.leave();
  res.json({ ok: true });
});

// GET /api/sync/status
router.get("/status", (_req: Request, res: Response) => {
  const engine = getSyncEngine();
  res.json({
    active: engine.isActive(),
    room: engine.getRoom(),
    peers: engine.getPeers(),
  });
});

export default router;
