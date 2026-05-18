import { Router, Request, Response } from "express";
import { getSyncEngine } from "../sync/syncEngine.js";
import { getDb } from "../db.js";
import { getController } from "../sync/playerController.js";

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
router.get("/status", async (_req: Request, res: Response) => {
  const engine = getSyncEngine();
  const ctrl = await getController();
  const status = ctrl ? await ctrl.getStatus() : null;
  res.json({
    active: engine.isActive(),
    hubConnected: engine.isActive(),
    room: engine.getRoom(),
    peers: engine.getPeers(),
    playerConnected: !!ctrl?.isConnected(),
    playerPosition: status?.position ?? 0,
    playerPaused: status?.paused ?? true,
    drift: 0,
  });
});

export default router;
