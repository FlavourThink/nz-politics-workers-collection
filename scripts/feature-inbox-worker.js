/**
 * Feature inbox — Cloudflare Worker.
 * POST { title, detail } appends to FlavourThink/nz-politics feature-requests.json.
 * Secrets: GITHUB_TOKEN (contents:write on FlavourThink/nz-politics)
 */
const DEFAULT_REPO = "FlavourThink/nz-politics";
const DEFAULT_PATH = "feature-requests.json";
const MAX_TITLE = 80;
const MAX_DETAIL = 400;
const MAX_ITEMS = 250;

function cors(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(req) },
  });
}

function clean(s, max) {
  return String(s || "").replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, max);
}

async function githubFile(env, method, sha, contentB64, message) {
  const repo = env.TARGET_REPO || DEFAULT_REPO;
  const path = env.TARGET_PATH || DEFAULT_PATH;
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("missing token");
  const url = "https://api.github.com/repos/" + repo + "/contents/" + path;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer " + token,
    "User-Agent": "nz-politics-features",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (method === "GET") {
    const r = await fetch(url, { headers });
    if (r.status === 404) return { sha: null, json: { updated: "", requests: [] } };
    if (!r.ok) throw new Error("read " + r.status);
    const data = await r.json();
    const text = atob(String(data.content || "").replace(/\n/g, ""));
    let parsed = { requests: [] };
    try { parsed = JSON.parse(text); } catch (e) { parsed = { requests: [] }; }
    if (!Array.isArray(parsed.requests)) parsed.requests = [];
    return { sha: data.sha, json: parsed };
  }
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message,
      content: contentB64,
      sha: sha || undefined,
      committer: { name: "nz-politics-bot", email: "bot@users.noreply.github.com" },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("write " + r.status + " " + t.slice(0, 180));
  }
  return r.json();
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method === "GET") {
      try {
        const file = await githubFile(env, "GET");
        return json(req, { ok: true, requests: file.json.requests || [] });
      } catch (e) {
        return json(req, { ok: false, error: "unavailable" }, 503);
      }
    }
    if (req.method !== "POST") return json(req, { ok: false, error: "method" }, 405);
    let body = {};
    try { body = await req.json(); } catch (e) { return json(req, { ok: false, error: "json" }, 400); }
    const title = clean(body.title, MAX_TITLE);
    const detail = clean(body.detail, MAX_DETAIL);
    if (title.length < 3 || detail.length < 8) return json(req, { ok: false, error: "short" }, 400);
    try {
      const file = await githubFile(env, "GET");
      const item = {
        id: "r-" + Date.now().toString(36),
        title: title,
        detail: detail,
        status: "new",
        at: new Date().toISOString(),
      };
      const requests = [item].concat(file.json.requests || []).slice(0, MAX_ITEMS);
      const next = { updated: item.at.slice(0, 10), repo: env.TARGET_REPO || DEFAULT_REPO, requests: requests };
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(next, null, 2))));
      await githubFile(env, "PUT", file.sha, b64, "feat: inbox " + item.id);
      return json(req, { ok: true, id: item.id, requests: requests });
    } catch (e) {
      return json(req, { ok: false, error: "save" }, 502);
    }
  },
};
