import { Router, Request, Response } from "express";
import { exec } from "child_process";
import { getDb } from "../db.js";
import path from "path";
import fs from "fs";

const router = Router();

// ─── GET /api/torrents/search?q=... ──────────────────────────────────────────

router.get("/search", async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.trim().length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  const db = getDb();
  const rssRow = db.prepare("SELECT value FROM settings WHERE key = 'torrent_rss_url'").get() as { value: string } | undefined;
  const rssTemplate = rssRow?.value || "https://nyaa.si/?page=rss&c=1_2&f=0&q=%title%";
  const rssUrl = rssTemplate.replace("%title%", encodeURIComponent(q.trim()));

  try {
    const response = await fetch(rssUrl, { headers: { "User-Agent": "AniTrack/1.0" } });
    if (!response.ok) {
      res.status(response.status).json({ error: "Torrent source returned an error" });
      return;
    }

    const text = await response.text();
    const items = text.match(/<item>([\s\S]*?)<\/item>/g) || [];
    const results = items.map((item: string) => {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
        || item.match(/<title>(.*?)<\/title>/)?.[1]
        || "Unknown";
      const link = item.match(/<nyaa:magnetUri>(.*?)<\/nyaa:magnetUri>/)?.[1]
        || item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1]
        || item.match(/<link>(.*?)<\/link>/)?.[1]
        || null;
      const size = item.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1]
        || item.match(/<contentLength>(.*?)<\/contentLength>/)?.[1]
        || "Unknown";
      const seeders = parseInt(item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/)?.[1] || "0");
      const leechers = parseInt(item.match(/<nyaa:leechers>(.*?)<\/nyaa:leechers>/)?.[1] || "0");
      return { title, link, size, seeders, leechers };
    }).filter((r: any) => r.link);

    res.json({ data: results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[torrents] Search error:", msg);
    res.status(500).json({ error: "Search failed" });
  }
});

// ─── POST /api/torrents/download ──────────────────────────────────────────────
// Body: { link, titleRomaji, animeId? }

router.post("/download", (req: Request, res: Response) => {
  const { link, titleRomaji, animeId } = req.body;

  if (!link || !titleRomaji) {
    res.status(400).json({ error: "link and titleRomaji are required" });
    return;
  }

  const db = getDb();

  // Get base folder from settings
  const baseRow = db
    .prepare("SELECT value FROM settings WHERE key = 'base_folder'")
    .get() as { value: string } | undefined;
  const baseFolder = baseRow?.value ?? "";

  // Get per-series override path if animeId provided
  let savePath: string;
  if (animeId) {
    const animeRow = db
      .prepare("SELECT download_path FROM anime WHERE id = ?")
      .get(animeId) as { download_path: string | null } | undefined;
    if (animeRow?.download_path) {
      savePath = animeRow.download_path;
    } else {
      savePath = baseFolder
        ? path.join(baseFolder, sanitizeFolderName(titleRomaji))
        : sanitizeFolderName(titleRomaji);
    }
  } else {
    savePath = baseFolder
      ? path.join(baseFolder, sanitizeFolderName(titleRomaji))
      : sanitizeFolderName(titleRomaji);
  }

  // Ensure save directory exists
  if (savePath && !fs.existsSync(savePath)) {
    try { fs.mkdirSync(savePath, { recursive: true }); } catch { /* ignore */ }
  }

  // Get torrent client path from settings
  const clientRow = db
    .prepare("SELECT value FROM settings WHERE key = 'torrent_client_path'")
    .get() as { value: string } | undefined;
  const clientPath = clientRow?.value?.trim() ?? "";

  if (clientPath) {
    // Silent injection into torrent client
    const isQbt = clientPath.toLowerCase().includes("qbittorrent");
    let command: string;

    if (isQbt) {
      command = `"${clientPath}" --save-path="${savePath}" --skip-dialog=true "${link}"`;
    } else {
      // Generic client (Transmission, Deluge, etc.) — just pass the link
      command = `"${clientPath}" "${link}"`;
    }

    exec(command, (err) => {
      if (err) console.error("[torrents] Client launch error:", err.message);
    });

    res.json({ success: true, method: "client", savePath });
  } else {
    // No client configured — open with system default magnet handler
    const opener =
      process.platform === "win32" ? "start" :
      process.platform === "darwin" ? "open" :
      "xdg-open";

    exec(`${opener} "${link}"`, (err) => {
      if (err) console.error("[torrents] System open error:", err.message);
    });

    res.json({ success: true, method: "system", savePath: null });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\.+$/, "")
    .trim();
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576)    return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default router;
