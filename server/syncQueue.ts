import Database from "better-sqlite3";
import { AniListTracker } from "./tracker/anilist.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueItemType = "progress" | "score";

export interface QueueItem {
  id: number;
  anilist_id: number;
  type: QueueItemType;
  progress: number | null;
  status: string | null;
  score: number | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Queue singleton ──────────────────────────────────────────────────────────

let _worker: ReturnType<typeof setTimeout> | null = null;
let _running = false;

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000]; // 5s, 30s, 2m, 5m
const MAX_ATTEMPTS = 5;
const WORKER_INTERVAL_MS = 10_000; // poll every 10s

// ─── Schema migration (called from db.ts migrate) ─────────────────────────────

export function migrateQueue(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      anilist_id  INTEGER NOT NULL,
      type        TEXT NOT NULL DEFAULT 'progress',
      progress    INTEGER,
      status      TEXT,
      score       REAL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_anilist ON sync_queue(anilist_id);
  `);
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────
// Deduplicates: if there's already a pending item for this anilist_id+type,
// update it in place (like Taiga's queue merge).

export function enqueue(
  db: Database.Database,
  anilist_id: number,
  type: QueueItemType,
  payload: { progress?: number; status?: string; score?: number }
): void {
  const existing = db
    .prepare(
      `SELECT id FROM sync_queue
       WHERE anilist_id = ? AND type = ? AND attempts < ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(anilist_id, type, MAX_ATTEMPTS) as { id: number } | undefined;

  if (existing) {
    // Merge into existing item
    const updates: string[] = ["updated_at = datetime('now')", "attempts = 0", "last_error = NULL"];
    const values: (string | number | null)[] = [];

    if (payload.progress !== undefined) { updates.push("progress = ?"); values.push(payload.progress); }
    if (payload.status   !== undefined) { updates.push("status = ?");   values.push(payload.status); }
    if (payload.score    !== undefined) { updates.push("score = ?");    values.push(payload.score); }

    values.push(existing.id);
    db.prepare(`UPDATE sync_queue SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    console.log(`[queue] Merged ${type} update for anilist_id ${anilist_id}`);
  } else {
    db.prepare(`
      INSERT INTO sync_queue (anilist_id, type, progress, status, score)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      anilist_id,
      type,
      payload.progress ?? null,
      payload.status   ?? null,
      payload.score    ?? null,
    );
    console.log(`[queue] Enqueued ${type} update for anilist_id ${anilist_id}`);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function processQueue(db: Database.Database): Promise<void> {
  if (_running) return;
  _running = true;

  try {
    const tokenRow = db
      .prepare("SELECT value FROM settings WHERE key = 'anilist_token'")
      .get() as { value: string } | undefined;

    if (!tokenRow?.value) return;

    const autoUpdate = db
      .prepare("SELECT value FROM settings WHERE key = 'auto_update_tracker'")
      .get() as { value: string } | undefined;

    if (autoUpdate?.value === "false") return;

    const token = tokenRow.value;
    const tracker = new AniListTracker();

    // Get all pending items ordered by id (oldest first)
    const items = db
      .prepare(
        `SELECT * FROM sync_queue
         WHERE attempts < ?
         ORDER BY id ASC`
      )
      .all(MAX_ATTEMPTS) as QueueItem[];

    for (const item of items) {
      // Respect retry delay based on attempt count
      if (item.attempts > 0) {
        const updatedAt = new Date(item.updated_at + "Z").getTime();
        const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        if (Date.now() - updatedAt < delay) continue;
      }

      try {
        if (item.type === "progress" && item.progress !== null && item.status !== null) {
          await tracker.updateProgress(token, String(item.anilist_id), item.progress, item.status);
          console.log(`[queue] ✓ Progress synced: anilist_id ${item.anilist_id} -> ${item.status} ep${item.progress}`);
        } else if (item.type === "score" && item.score !== null) {
          await tracker.updateScore(token, String(item.anilist_id), item.score);
          console.log(`[queue] ✓ Score synced: anilist_id ${item.anilist_id} -> ${item.score}`);
        }

        // Success — remove from queue
        db.prepare("DELETE FROM sync_queue WHERE id = ?").run(item.id);

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[queue] ✗ Failed (attempt ${item.attempts + 1}): anilist_id ${item.anilist_id} — ${msg}`);

        db.prepare(`
          UPDATE sync_queue
          SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(msg, item.id);

        // If AniList is rate limiting or having server issues, stop processing for now
        if (msg.includes("429") || msg.includes("500") || msg.includes("503")) {
          console.warn("[queue] AniList API issue detected, pausing queue processing");
          break;
        }
      }
    }
  } finally {
    _running = false;
  }
}

// ─── Start/stop worker ────────────────────────────────────────────────────────

export function startQueueWorker(db: Database.Database): void {
  if (_worker) return;
  console.log("[queue] Worker started");

  const tick = async () => {
    await processQueue(db);
    _worker = setTimeout(tick, WORKER_INTERVAL_MS);
  };

  // Start after a short delay to let the server settle
  _worker = setTimeout(tick, 3_000);
}

export function stopQueueWorker(): void {
  if (_worker) {
    clearTimeout(_worker);
    _worker = null;
    console.log("[queue] Worker stopped");
  }
}
