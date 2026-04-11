import { Router, Request, Response } from "express";
import { getDb } from "../db.js";
import http from "http";
import crypto from "crypto";
import { MALTracker, MAL_CLIENT_ID } from "../tracker/mal.js";

const router = Router();

// PKCE helpers
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(64));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

// Temp store for PKCE verifier during OAuth flow
let _codeVerifier: string | null = null;
let _oauthServer: http.Server | null = null;

// ─── GET /api/mal/auth-url ────────────────────────────────────────────────────
// Returns the MAL OAuth URL and starts the local callback server

router.get("/auth-url", (req: Request, res: Response) => {
  _codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(_codeVerifier);

  // Start local callback server
  startCallbackServer();

  // MAL "other" app type requires plain PKCE, not S256
  const params = new URLSearchParams({
    response_type: "code",
    client_id: MAL_CLIENT_ID,
    redirect_uri: "http://localhost:54321/callback",
    code_challenge: _codeVerifier, // plain: challenge == verifier
    code_challenge_method: "plain",
  });

  const url = `https://myanimelist.net/v1/oauth2/authorize?${params}`;
  res.json({ url });
});

// ─── POST /api/mal/exchange ───────────────────────────────────────────────────
// Exchange auth code for token (called by the callback server)

async function exchangeCode(code: string): Promise<void> {
  if (!_codeVerifier) throw new Error("No code verifier — restart auth flow");

  const body = new URLSearchParams({
    client_id: MAL_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:54321/callback",
    code_verifier: _codeVerifier,
  });

  const res = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MAL token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("mal_token", data.access_token);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("mal_refresh_token", data.refresh_token);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "mal_token_expires_at",
    String(Date.now() + data.expires_in * 1000)
  );

  console.log("[mal-auth] Token saved successfully");
  _codeVerifier = null;
}

// ─── Local callback HTTP server ───────────────────────────────────────────────

function startCallbackServer(): void {
  if (_oauthServer) return; // already running

  _oauthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost:54321");

    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error || !code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif;background:#111;color:#f44;padding:2rem">
        <h2>Authentication failed</h2><p>${error ?? "No code received"}</p>
        <p>You can close this window.</p></body></html>`);
      stopCallbackServer();
      return;
    }

    try {
      await exchangeCode(code);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif;background:#111;color:#4ade80;padding:2rem">
        <h2>✓ Connected to MyAnimeList!</h2>
        <p>You can close this window and return to AniTrack.</p></body></html>`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[mal-auth] Exchange failed:", msg);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif;background:#111;color:#f44;padding:2rem">
        <h2>Authentication error</h2><p>${msg}</p>
        <p>You can close this window.</p></body></html>`);
    }

    stopCallbackServer();
  });

  _oauthServer.listen(54321, "127.0.0.1", () => {
    console.log("[mal-auth] Callback server listening on http://localhost:54321");
  });
}

function stopCallbackServer(): void {
  if (_oauthServer) {
    _oauthServer.close();
    _oauthServer = null;
    console.log("[mal-auth] Callback server stopped");
  }
}

// ─── GET /api/mal/user ────────────────────────────────────────────────────────

router.get("/user", async (req: Request, res: Response) => {
  const db = getDb();
  const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'mal_token'").get() as { value: string } | undefined;

  if (!tokenRow?.value) {
    res.status(401).json({ error: "Not connected" });
    return;
  }

  try {
    const tracker = new MALTracker();
    const user = await tracker.getUser(tokenRow.value);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});

// ─── DELETE /api/mal/disconnect ───────────────────────────────────────────────

router.delete("/disconnect", (req: Request, res: Response) => {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key IN ('mal_token', 'mal_refresh_token', 'mal_token_expires_at')").run();
  console.log("[mal-auth] Disconnected");
  res.json({ ok: true });
});

export default router;
