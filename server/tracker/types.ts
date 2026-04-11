// ─── Shared tracker types ─────────────────────────────────────────────────────

export interface TrackerSearchResult {
  id: string;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  coverImage: string | null;
  format: string | null;
  status: string | null;
  seasonYear: number | null;
  totalEpisodes: number | null;
}

export interface TrackerAnimeDetail extends TrackerSearchResult {
  bannerImage: string | null;
  season: string | null;
  genres: string[];
  description: string | null;
  averageScore: number | null;
  episodes: TrackerEpisode[];
}

export interface TrackerEpisode {
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  thumbnail: string | null;
}

export interface TrackerUserListEntry {
  trackerId: string;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  coverImage: string | null;
  bannerImage: string | null;
  // Normalized internal status: WATCHING | COMPLETED | PLANNING | DROPPED | PAUSED
  status: string;
  // Always stored as 0–10 internally, regardless of tracker's native format
  score: number | null;
  progress: number;
  totalEpisodes: number | null;
  format: string | null;
  season: string | null;
  seasonYear: number | null;
  genres: string[];
  description: string | null;
  averageScore: number | null;
}

// ─── Tracker interface ────────────────────────────────────────────────────────

export interface ITracker {
  name: string;
  search(query: string): Promise<TrackerSearchResult[]>;
  getAnime(id: string): Promise<TrackerAnimeDetail>;
  getUserList(token: string): Promise<TrackerUserListEntry[]>;
  updateProgress(token: string, mediaId: string, progress: number, status: string): Promise<void>;
  updateScore(token: string, mediaId: string, score: number): Promise<void>;
}
