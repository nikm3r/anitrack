import type {
  ITracker,
  TrackerSearchResult,
  TrackerAnimeDetail,
  TrackerUserListEntry,
} from "./types.js";

// ─── MAL API docs: https://myanimelist.net/apiconfig/references/api/v2 ────────
//
// Auth: OAuth 2.0 with PKCE. The frontend handles the auth flow and stores the
// access token via PUT /api/settings/mal_token.
//
// Score format: MAL uses integers 0–10 natively, matching our internal format.
//
// Status mapping (MAL → internal):
//   watching      → WATCHING
//   completed     → COMPLETED
//   plan_to_watch → PLANNING
//   dropped       → DROPPED
//   on_hold       → PAUSED
//
// Pagination: MAL list API returns max 1000 entries per page; we paginate
// until we get fewer results than the requested limit.

const MAL_BASE = "https://api.myanimelist.net/v2";
export const MAL_CLIENT_ID = "440f4a036c2f7b88b5f458454e49a3c0";
const MAL_CLIENT_ID_HEADER = "X-MAL-CLIENT-ID";

// Standard fields requested for all anime queries
const ANIME_FIELDS = [
  "id",
  "title",
  "alternative_titles",
  "main_picture",
  "num_episodes",
  "status",
  "genres",
  "mean",
  "start_season",
  "media_type",
  "synopsis",
].join(",");

// Fields for user list entries (lighter — no synopsis to keep responses fast)
const LIST_FIELDS = [
  "id",
  "title",
  "alternative_titles",
  "main_picture",
  "num_episodes",
  "status",
  "mean",
  "start_season",
  "media_type",
  "my_list_status{status,score,num_episodes_watched}",
].join(",");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStatus(malStatus: string): string {
  const map: Record<string, string> = {
    watching:      "WATCHING",
    completed:     "COMPLETED",
    plan_to_watch: "PLANNING",
    dropped:       "DROPPED",
    on_hold:       "PAUSED",
  };
  return map[malStatus] ?? "PLANNING";
}

function denormalizeStatus(internalStatus: string): string {
  const map: Record<string, string> = {
    WATCHING:  "watching",
    COMPLETED: "completed",
    PLANNING:  "plan_to_watch",
    DROPPED:   "dropped",
    PAUSED:    "on_hold",
  };
  return map[internalStatus] ?? "plan_to_watch";
}

function normalizeFormat(mediaType: string | null): string | null {
  if (!mediaType) return null;
  // MAL types: tv, ova, movie, special, ona, music, manga, novel, one_shot, doujinshi, manhwa, manhua
  const map: Record<string, string> = {
    tv:      "TV",
    ova:     "OVA",
    movie:   "MOVIE",
    special: "SPECIAL",
    ona:     "ONA",
    music:   "MUSIC",
  };
  return map[mediaType.toLowerCase()] ?? mediaType.toUpperCase();
}

function normalizeAnimeStatus(malStatus: string | null): string | null {
  if (!malStatus) return null;
  const map: Record<string, string> = {
    finished_airing:    "FINISHED",
    currently_airing:   "RELEASING",
    not_yet_aired:      "NOT_YET_RELEASED",
  };
  return map[malStatus] ?? malStatus;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function malGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${MAL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MAL API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  return res.json() as Promise<T>;
}

async function malPatch(
  path: string,
  token: string,
  body: Record<string, string | number>
): Promise<void> {
  const url = `${MAL_BASE}${path}`;
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MAL API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
}

// ─── MAL response types ───────────────────────────────────────────────────────

interface MalPicture {
  medium: string;
  large: string;
}

interface MalAnime {
  id: number;
  title: string;
  alternative_titles?: {
    en?: string;
    ja?: string;
    synonyms?: string[];
  };
  main_picture?: MalPicture | null;
  num_episodes?: number | null;
  status?: string | null;
  genres?: { id: number; name: string }[];
  mean?: number | null;
  start_season?: { year: number; season: string } | null;
  media_type?: string | null;
  synopsis?: string | null;
  my_list_status?: {
    status: string;
    score: number;
    num_episodes_watched: number;
  } | null;
}

interface MalListResponse {
  data: { node: MalAnime }[];
  paging?: { next?: string };
}

// ─── MALTracker ───────────────────────────────────────────────────────────────

export class MALTracker implements ITracker {
  name = "mal";

  async search(query: string): Promise<TrackerSearchResult[]> {
    // MAL search requires a client_id even without a user token.
    // We read it from the environment; the user stores it in settings and
    // the server injects it via process.env.MAL_CLIENT_ID.
    // For authenticated calls we use the token header instead.
    // Since search is called with the user's token (from the queue worker
    // context), we fall back to a client_id-only header if no token.
    // In practice, search is always called from tracker.ts which has the token.
    throw new Error(
      "MAL search requires a token — call via /api/tracker/search with active_tracker=mal and a valid mal_token"
    );
  }

  async searchWithToken(query: string, token: string): Promise<TrackerSearchResult[]> {
    type SearchResponse = { data: { node: MalAnime }[] };

    const data = await malGet<SearchResponse>("/anime", token, {
      q: query,
      limit: "20",
      fields: ANIME_FIELDS,
    });

    return data.data.map(({ node: m }) => this._toSearchResult(m));
  }

  async getAnime(id: string): Promise<TrackerAnimeDetail> {
    // getAnime is called without a token in some contexts (e.g. tracker.ts sync).
    // MAL requires auth for all requests, so we need the token.
    // tracker.ts passes the token separately — we handle that via getAnimeWithToken.
    throw new Error("MAL getAnime requires a token — use getAnimeWithToken");
  }

  async getAnimeWithToken(id: string, token: string): Promise<TrackerAnimeDetail> {
    const m = await malGet<MalAnime>(`/anime/${id}`, token, {
      fields: ANIME_FIELDS,
    });

    return {
      id: String(m.id),
      titleRomaji: m.title,
      titleEnglish: m.alternative_titles?.en || null,
      titleNative: m.alternative_titles?.ja || null,
      coverImage: m.main_picture?.large ?? m.main_picture?.medium ?? null,
      bannerImage: null, // MAL does not provide banner images
      format: normalizeFormat(m.media_type ?? null),
      status: normalizeAnimeStatus(m.status ?? null),
      season: m.start_season?.season?.toUpperCase() ?? null,
      seasonYear: m.start_season?.year ?? null,
      totalEpisodes: m.num_episodes ?? null,
      genres: m.genres?.map(g => g.name) ?? [],
      description: m.synopsis ?? null,
      averageScore: m.mean != null ? Math.round(m.mean * 10) : null, // MAL mean is 0–10, convert to 0–100 to match AniList
      episodes: [], // MAL API does not expose per-episode data in v2
    };
  }

  async getUserList(token: string): Promise<TrackerUserListEntry[]> {
    const entries: TrackerUserListEntry[] = [];
    let nextUrl: string | undefined = undefined;
    let page = 0;

    // MAL paginates via a "paging.next" URL. We follow it until exhausted.
    do {
      let data: MalListResponse;

      if (nextUrl) {
        // Follow the paging cursor directly
        const res = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`MAL API error: ${res.status} ${res.statusText}`);
        data = await res.json() as MalListResponse;
      } else {
        data = await malGet<MalListResponse>("/users/@me/animelist", token, {
          fields: LIST_FIELDS,
          limit: "1000",
          sort: "list_updated_at",
          nsfw: "true",
        });
      }

      for (const { node: m } of data.data) {
        const listStatus = m.my_list_status;
        if (!listStatus) continue; // entry with no list data — skip

        entries.push({
          trackerId: String(m.id),
          titleRomaji: m.title,
          titleEnglish: m.alternative_titles?.en || null,
          titleNative: m.alternative_titles?.ja || null,
          coverImage: m.main_picture?.large ?? m.main_picture?.medium ?? null,
          bannerImage: null,
          status: normalizeStatus(listStatus.status),
          // MAL score is already 0–10 (integer), matching our internal format.
          // 0 means "not scored" on MAL.
          score: listStatus.score > 0 ? listStatus.score : null,
          progress: listStatus.num_episodes_watched,
          totalEpisodes: m.num_episodes ?? null,
          format: normalizeFormat(m.media_type ?? null),
          season: m.start_season?.season?.toUpperCase() ?? null,
          seasonYear: m.start_season?.year ?? null,
          genres: m.genres?.map(g => g.name) ?? [],
          description: null,
          averageScore: m.mean != null ? Math.round(m.mean * 10) : null,
        });
      }

      nextUrl = data.paging?.next;
      page++;

      // Safety cap: 10 pages × 1000 = 10,000 entries — more than anyone has
      if (page >= 10) break;

    } while (nextUrl);

    console.log(`[mal] Fetched ${entries.length} list entries`);
    return entries;
  }

  async updateProgress(token: string, mediaId: string, progress: number, status: string): Promise<void> {
    const malStatus = denormalizeStatus(status);

    await malPatch(`/anime/${mediaId}/my_list_status`, token, {
      status: malStatus,
      num_watched_episodes: progress,
    });

    console.log(`[mal] Updated progress for media ${mediaId}: ep ${progress} (${malStatus})`);
  }

  async updateScore(token: string, mediaId: string, score: number): Promise<void> {
    // MAL score is integer 0–10. We clamp and round just in case.
    const malScore = Math.max(0, Math.min(10, Math.round(score)));

    await malPatch(`/anime/${mediaId}/my_list_status`, token, {
      score: malScore,
    });

    console.log(`[mal] Updated score for media ${mediaId}: ${malScore}`);
  }

  async getUser(token: string): Promise<{ id: number; name: string; picture: string | null }> {
    const data = await malGet<{ id: number; name: string; picture?: string }>(
      "/users/@me",
      token,
      { fields: "id,name,picture" }
    );
    return {
      id: data.id,
      name: data.name,
      picture: data.picture ?? null,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async deleteEntry(token: string, mediaId: string): Promise<void> {
    await fetch(`https://api.myanimelist.net/v2/anime/${mediaId}/my_list_status`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[mal] Deleted list entry for media ${mediaId}`);
  }

  private _toSearchResult(m: MalAnime): TrackerSearchResult {
    return {
      id: String(m.id),
      titleRomaji: m.title,
      titleEnglish: m.alternative_titles?.en || null,
      titleNative: m.alternative_titles?.ja || null,
      coverImage: m.main_picture?.large ?? m.main_picture?.medium ?? null,
      format: normalizeFormat(m.media_type ?? null),
      status: normalizeAnimeStatus(m.status ?? null),
      seasonYear: m.start_season?.year ?? null,
      totalEpisodes: m.num_episodes ?? null,
    };
  }
}
