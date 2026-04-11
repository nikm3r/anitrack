import { Router, Request, Response } from "express";
import { getDb } from "../db.js";
import { AniListTracker } from "../tracker/anilist.js";
import { MALTracker } from "../tracker/mal.js";
import type { TrackerSearchResult, TrackerAnimeDetail, ITracker } from "../tracker/types.js";

const router = Router();

// ─── Tracker factory ──────────────────────────────────────────────────────────

function getTracker(name: string): ITracker {
  switch (name) {
    case "anilist": return new AniListTracker();
    case "mal":     return new MALTracker();
    default:        throw new Error(`Unknown tracker: ${name}`);
  }
}

function getActiveTrackerName(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'active_tracker'")
    .get() as { value: string } | undefined;
  return row?.value ?? "anilist";
}

function getTrackerToken(db: ReturnType<typeof getDb>, trackerName: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`${trackerName}_token`) as { value: string } | undefined;
  return row?.value?.trim() || null;
}

// ─── GET /api/tracker/search?q=... ───────────────────────────────────────────

router.get("/search", async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.trim().length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const trackerName = (req.query.tracker as string) || getActiveTrackerName();
  const db = getDb();
  const token = getTrackerToken(db, trackerName);

  try {
    let results: TrackerSearchResult[];

    if (trackerName === "mal") {
      // MAL requires a token even for search
      if (!token) {
        res.status(401).json({ error: "MAL token not configured" });
        return;
      }
      const tracker = new MALTracker();
      results = await tracker.searchWithToken(q.trim(), token);
    } else {
      // AniList search is unauthenticated
      const tracker = getTracker(trackerName) as AniListTracker;
      results = await tracker.search(q.trim());
    }

    res.json({ data: results, tracker: trackerName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/tracker/anime/:id ───────────────────────────────────────────────

router.get("/anime/:id", async (req: Request, res: Response) => {
  const trackerName = (req.query.tracker as string) || getActiveTrackerName();
  const db = getDb();
  const token = getTrackerToken(db, trackerName);

  try {
    let detail: TrackerAnimeDetail;

    if (trackerName === "mal") {
      if (!token) {
        res.status(401).json({ error: "MAL token not configured" });
        return;
      }
      const tracker = new MALTracker();
      detail = await tracker.getAnimeWithToken(req.params.id, token);
    } else {
      const tracker = getTracker(trackerName) as AniListTracker;
      detail = await tracker.getAnime(req.params.id);
    }

    res.json({ data: detail, tracker: trackerName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/tracker/sync/:animeId ─────────────────────────────────────────
// Pull latest metadata from tracker and update local DB

router.post("/sync/:animeId", async (req: Request, res: Response) => {
  const db = getDb();
  const animeId = parseInt(req.params.animeId, 10);
  const trackerName = (req.body.tracker as string) || getActiveTrackerName();
  const token = getTrackerToken(db, trackerName);

  const local = db
    .prepare("SELECT * FROM anime WHERE id = ?")
    .get(animeId) as { anilist_id: number | null; mal_id: number | null } | undefined;

  if (!local) {
    res.status(404).json({ error: "Anime not found in library" });
    return;
  }

  const trackerId = trackerName === "anilist" ? local.anilist_id : local.mal_id;

  if (!trackerId) {
    res.status(400).json({ error: `No ${trackerName} ID linked to this anime` });
    return;
  }

  try {
    let detail: TrackerAnimeDetail;

    if (trackerName === "mal") {
      if (!token) {
        res.status(401).json({ error: "MAL token not configured" });
        return;
      }
      const tracker = new MALTracker();
      detail = await tracker.getAnimeWithToken(String(trackerId), token);
    } else {
      const tracker = getTracker(trackerName) as AniListTracker;
      detail = await tracker.getAnime(String(trackerId));
    }

    db.prepare(`
      UPDATE anime SET
        title_romaji   = ?,
        title_english  = ?,
        title_native   = ?,
        cover_image    = ?,
        banner_image   = ?,
        total_episodes = ?,
        format         = ?,
        season         = ?,
        season_year    = ?,
        genres         = ?,
        updated_at     = datetime('now')
      WHERE id = ?
    `).run(
      detail.titleRomaji,
      detail.titleEnglish ?? null,
      detail.titleNative ?? null,
      detail.coverImage ?? null,
      detail.bannerImage ?? null,
      detail.totalEpisodes ?? null,
      detail.format ?? null,
      detail.season ?? null,
      detail.seasonYear ?? null,
      detail.genres ? JSON.stringify(detail.genres) : null,
      animeId
    );

    const updated = db.prepare("SELECT * FROM anime WHERE id = ?").get(animeId);
    res.json({ data: updated, synced: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/tracker/user-list ───────────────────────────────────────────────

router.get("/user-list", async (req: Request, res: Response) => {
  const db = getDb();
  const trackerName = (req.query.tracker as string) || getActiveTrackerName();
  const token = getTrackerToken(db, trackerName);

  if (!token) {
    res.status(401).json({ error: `No ${trackerName} token configured` });
    return;
  }

  try {
    const tracker = getTracker(trackerName);
    const list = await tracker.getUserList(token);
    res.json({ data: list, tracker: trackerName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/tracker/mal-token ─────────────────────────────────────────────
// Exchanges a MAL authorisation code for an access token.
// Done server-side to avoid CORS — MAL's token endpoint allows cross-origin
// from the backend but not from the browser directly.
//
// Body: { code, code_verifier, client_id, redirect_uri }
// Returns: { access_token, refresh_token, expires_in }
//
// redirect_uri must match exactly what was used in the auth URL and what
// the user registered in their MAL app config:
//   http://localhost:54321/callback

const MAL_REDIRECT_URI = "http://localhost:54321/callback";

router.post("/mal-token", async (req: Request, res: Response) => {
  const { code, code_verifier, client_id, redirect_uri } = req.body;

  if (!code || !code_verifier || !client_id) {
    res.status(400).json({ error: "code, code_verifier, and client_id are required" });
    return;
  }

  // Use the redirect_uri from the request if provided, otherwise fall back to the default.
  // Both must match what was used in the original auth URL.
  const resolvedRedirectUri = redirect_uri || MAL_REDIRECT_URI;

  try {
    const form = new URLSearchParams({
      client_id,
      code,
      code_verifier,
      redirect_uri: resolvedRedirectUri,
      grant_type: "authorization_code",
    });

    const response = await fetch("https://myanimelist.net/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.status(response.status).json({
        error: `MAL token exchange failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
      });
      return;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };

    // Persist both tokens to settings so the queue worker can use them
    const db = getDb();
    const upsert = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    upsert.run("mal_token", data.access_token);
    upsert.run("mal_refresh_token", data.refresh_token ?? "");

    console.log("[mal] Token exchanged and saved successfully");

    res.json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mal] Token exchange error:", msg);
    res.status(500).json({ error: msg });
  }
});

export default router;

