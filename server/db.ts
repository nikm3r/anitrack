import Database from "better-sqlite3";
import { migrateQueue } from "./syncQueue.js";
import path from "path";
import fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Anime {
  id: number;
  anilist_id: number | null;
  mal_id: number | null;
  title_romaji: string;
  title_english: string | null;
  title_native: string | null;
  cover_image: string | null;
  banner_image: string | null;
  status: string;
  score: number | null;
  progress: number;
  total_episodes: number | null;
  format: string | null;
  season: string | null;
  season_year: number | null;
  genres: string | null;         // JSON string
  description: string | null;
  average_score: number | null;
  alt_title: string | null;
  download_path: string | null;
  notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: number;
  anime_id: number;
  episode_number: number;
  title: string | null;
  air_date: string | null;
  watched: number;
  watched_at: string | null;
  file_path: string | null;
  created_at: string;
}

export interface Settings {
  key: string;
  value: string;
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbDir =
    process.env.USER_DATA_PATH ||
    path.join(process.env.HOME || "~", ".anitrack");

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, "anitrack.db");
  console.log("[db] Opening database at:", dbPath);

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

// ─── Migrations ───────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS anime (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        anilist_id      INTEGER UNIQUE,
        mal_id          INTEGER UNIQUE,
        title_romaji    TEXT NOT NULL,
        title_english   TEXT,
        title_native    TEXT,
        cover_image     TEXT,
        banner_image    TEXT,
        status          TEXT NOT NULL DEFAULT 'PLANNING',
        score           INTEGER,
        progress        INTEGER NOT NULL DEFAULT 0,
        total_episodes  INTEGER,
        format          TEXT,
        season          TEXT,
        season_year     INTEGER,
        genres          TEXT,
        description     TEXT,
        average_score   INTEGER,
        alt_title       TEXT,
        download_path   TEXT,
        notes           TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        anime_id        INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
        episode_number  INTEGER NOT NULL,
        title           TEXT,
        air_date        TEXT,
        watched         INTEGER NOT NULL DEFAULT 0,
        watched_at      TEXT,
        file_path       TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(anime_id, episode_number)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_anime_status     ON anime(status);
      CREATE INDEX IF NOT EXISTS idx_anime_anilist_id ON anime(anilist_id);
      CREATE INDEX IF NOT EXISTS idx_anime_mal_id     ON anime(mal_id);
      CREATE INDEX IF NOT EXISTS idx_episodes_anime   ON episodes(anime_id);

      INSERT INTO schema_version (version) VALUES (1);
    `);
    console.log("[db] Migrated to schema v1");
  }

  if (current < 2) {
    // Add columns that were missing in early v1 installs.
    // Only ignores "duplicate column name" — re-throws anything else.
    const columnsToAdd: [string, string][] = [
      ["alt_title", "TEXT"],
      ["description", "TEXT"],
      ["average_score", "INTEGER"],
    ];

    for (const [col, type] of columnsToAdd) {
      try {
        db.exec(`ALTER TABLE anime ADD COLUMN ${col} ${type};`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes("duplicate column name")) {
          throw new Error(`[db] Migration v2 failed adding column "${col}": ${msg}`);
        }
      }
    }

    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (2);`);
    console.log("[db] Migrated to schema v2");
  }

  if (current < 3) {
    // Add UNIQUE constraint to mal_id.
    // SQLite does not support ALTER TABLE ADD CONSTRAINT, so we must
    // recreate the table. We use db.transaction() for atomicity.
    //
    // IMPORTANT: foreign_keys must be OFF during the table rename because
    // the episodes table has a FK referencing anime(id). SQLite ≥ 3.26
    // enforces FK checks on ALTER TABLE RENAME even though the rename is
    // safe — we turn it off, do the work, then restore it.

    db.pragma("foreign_keys = OFF");

    try {
      const v3 = db.transaction(() => {
        // better-sqlite3 requires one statement per exec() call inside a transaction
        db.exec(`ALTER TABLE anime RENAME TO anime_old`);
        db.exec(`
          CREATE TABLE anime (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            anilist_id      INTEGER UNIQUE,
            mal_id          INTEGER UNIQUE,
            title_romaji    TEXT NOT NULL,
            title_english   TEXT,
            title_native    TEXT,
            cover_image     TEXT,
            banner_image    TEXT,
            status          TEXT NOT NULL DEFAULT 'PLANNING',
            score           INTEGER,
            progress        INTEGER NOT NULL DEFAULT 0,
            total_episodes  INTEGER,
            format          TEXT,
            season          TEXT,
            season_year     INTEGER,
            genres          TEXT,
            description     TEXT,
            average_score   INTEGER,
            alt_title       TEXT,
            download_path   TEXT,
            notes           TEXT,
            started_at      TEXT,
            completed_at    TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(`INSERT INTO anime SELECT * FROM anime_old`);
        db.exec(`DROP TABLE anime_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_anime_status     ON anime(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_anime_anilist_id ON anime(anilist_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_anime_mal_id     ON anime(mal_id)`);
        db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (3)`);
        db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('mal_client_id', '')`);
        db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('mal_refresh_token', '')`);
      });

      v3();
      console.log("[db] Migrated to schema v3 (mal_id UNIQUE, MAL OAuth fields)");
    } finally {
      // Always restore foreign keys, whether migration succeeded or failed
      db.pragma("foreign_keys = ON");
    }
  }

  if (current < 4) {
    // Drop old sync_queue (had anilist_id column) — migrateQueue will recreate with tracker_id
    try {
      db.exec(`DROP TABLE IF EXISTS sync_queue;`);
      db.exec(`DROP INDEX IF EXISTS idx_sync_queue_tracker;`);
    } catch {}
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (4);`);
    console.log("[db] Migrated to schema v4 - rebuilt sync_queue");
  }

  // Always ensure queue table exists and is up to date
  migrateQueue(db);
}

export function touchUpdatedAt(db: Database.Database, id: number): void {
  db.prepare("UPDATE anime SET updated_at = datetime('now') WHERE id = ?").run(id);
}
