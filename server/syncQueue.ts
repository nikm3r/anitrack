import Database from "better-sqlite3";
import { AniListTracker } from "./tracker/anilist.js";
import { MALTracker } from "./tracker/mal.js";
import type { ITracker } from "./tracker/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueItemType = "progress" | "score";

export interface QueueItem {
  id: number;
  // Generic tracker_id: stores anilist_id or mal_id depending on active_tracker at enqueue time.
  // The column is kept as "tracker_id" in the DB going forward (migrated from "anilist_id").
  tracker_id: number;
  tracker: string;      // "anilist" | "mal" — which tracker this item belongs to
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
const WORKER_INTERVAL_MS = 10_000;

// ─── Schema migration ─────────────────────────────────────────────────────────

export function migrateQueue(db: Database.Database): void {
  // Create table if it doesn't exist at all (fresh install)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id  INTEGER NOT NULL,
      tracker     TEXT NOT NULL DEFAULT 'anilist',
      type        TEXT NOT NULL DEFAULT 'progress',
      progress    INTEGER,
      status      TEXT,
      score       REAL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_tracker ON sync_queue(tracker_id, tracker);
  `);

  // Migration: if old schema had "anilist_id" column instead of "tracker_id", rename it.
  // We check by looking at the column list.
  const cols = (db.prepare("PRAGMA table_info(sync_queue)").all() as { name: string }[]).map(c => c.name);
  if (cols.includes("anilist_id") && !cols.includes("tracker_id")) {
    db.exec(`ALTER TABLE sync_queue RENAME COLUMN anilist_id TO tracker_id;`);
    console.log("[queue] Migrated sync_queue: renamed anilist_id → tracker_id");
  }
  if (!cols.includes("tracker")) {
    db.exec(`ALTER TABLE sync_queue ADD COLUMN tracker TEXT NOT NULL DEFAULT 'anilist';`);
    console.log("[queue] Migrated sync_queue: added tracker column");
  }
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────
// Deduplicates: if there's already a pending item for this tracker_id+tracker+type,
// update it in place.

export function enqueue(
  db: Database.Database,
  tracker_id: number,
  tracker: string,
  type: QueueItemType,
  payload: { progress?: number; status?: string; score?: number }
): void {
  const existing = db
    .prepare(
      `SELECT id FROM sync_queue
       WHERE tracker_id = ? AND tracker = ? AND type = ? AND attempts < ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(tracker_id, tracker, type, MAX_ATTEMPTS) as { id: number } | undefined;

  if (existing) {
    const updates: string[] = ["updated_at = datetime('now')", "attempts = 0", "last_error = NULL"];
    const values: (string | number | null)[] = [];

    if (payload.progress !== undefined) { updates.push("progress = ?"); values.push(payload.progress); }
    if (payload.status   !== undefined) { updates.push("status = ?");   values.push(payload.status); }
    if (payload.score    !== undefined) { updates.push("score = ?");    values.push(payload.score); }

    values.push(existing.id);
    db.prepare(`UPDATE sync_queue SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    console.log(`[queue] Merged ${type} update for ${tracker}:${tracker_id}`);
  } else {
    db.prepare(`
      INSERT INTO sync_queue (tracker_id, tracker, type, progress, status, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      tracker_id,
      tracker,
      type,
      payload.progress ?? null,
      payload.status   ?? null,
      payload.score    ?? null,
    );
    console.log(`[queue] Enqueued ${type} update for ${tracker}:${tracker_id}`);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function processQueue(db: Database.Database): Promise<void> {
  if (_running) return;
  _running = true;

  try {
    const autoUpdate = db
      .prepare("SELECT value FROM settings WHERE key = 'auto_update_tracker'")
      .get() as { value: string } | undefined;
    if (autoUpdate?.value === "false") return;

    // Process each tracker's queue independently
    for (const trackerName of ["anilist", "mal"]) {
      const tokenRow = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(`${trackerName}_token`) as { value: string } | undefined;

      if (!tokenRow?.value?.trim()) continue; // no token for this tracker — skip

      const token = tokenRow.value.trim();

      // Get pending items for this tracker
      const items = db
        .prepare(
          `SELECT * FROM sync_queue
           WHERE tracker = ? AND attempts < ?
           ORDER BY id ASC`
        )
        .all(trackerName, MAX_ATTEMPTS) as QueueItem[];

      if (items.length === 0) continue;

      // Build the tracker instance once per batch
      let tracker: ITracker;
      try {
        tracker = trackerName === "mal" ? new MALTracker() : new AniListTracker();
      } catch {
        continue;
      }

      for (const item of items) {
        // Respect retry delay based on attempt count
        if (item.attempts > 0) {
          const updatedAt = new Date(item.updated_at + "Z").getTime();
          const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
          if (Date.now() - updatedAt < delay) continue;
        }

        try {
          if (item.type === "progress" && item.progress !== null && item.status !== null) {
            await tracker.updateProgress(token, String(item.tracker_id), item.progress, item.status);
            console.log(`[queue] ✓ Progress synced: ${trackerName}:${item.tracker_id} -> ${item.status} ep${item.progress}`);
          } else if (item.type === "score" && item.score !== null) {
            await tracker.updateScore(token, String(item.tracker_id), item.score);
            console.log(`[queue] ✓ Score synced: ${trackerName}:${item.tracker_id} -> ${item.score}`);
          }

          db.prepare("DELETE FROM sync_queue WHERE id = ?").run(item.id);

        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[queue] ✗ Failed (attempt ${item.attempts + 1}): ${trackerName}:${item.tracker_id} — ${msg}`);

          db.prepare(`
            UPDATE sync_queue
            SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(msg, item.id);

          // Rate limit or server error — stop processing this tracker's queue for now
          if (msg.includes("429") || msg.includes("500") || msg.includes("503")) {
            console.warn(`[queue] ${trackerName} API issue detected, pausing queue processing`);
            break;
          }
        }
      }
    }
  } finally {
    _running = false;
  }
}

// ─── Start/stop ───────────────────────────────────────────────────────────────

export function startQueueWorker(db: Database.Database): void {
  if (_worker) return;
  console.log("[queue] Worker started");

  const tick = async () => {
    await processQueue(db);
    _worker = setTimeout(tick, WORKER_INTERVAL_MS);
  };

  _worker = setTimeout(tick, 3_000);
}

export function stopQueueWorker(): void {
  if (_worker) {
    clearTimeout(_worker);
    _worker = null;
    console.log("[queue] Worker stopped");
  }
}
