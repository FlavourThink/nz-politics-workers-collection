/**
 * EXAMPLE vote door — deploy somewhere server-side (e.g. Cloudflare Worker).
 * Do NOT put VOTE_WEBHOOK_SECRET or a GitHub token in the public website.
 *
 * Browser → this door → GitHub repository_dispatch → "Record vote" workflow
 *
 * Required env on the door:
 *   GITHUB_TOKEN      — fine-grained PAT: Contents read, Actions write (or repo scope)
 *   VOTE_WEBHOOK_SECRET — same value as repo secret VOTE_WEBHOOK_SECRET
 *   GITHUB_REPO       — FlavourThink/nz-politics-workers-collection
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    // Human check: website must send humanVerified: true after the user passes the gate once
    if (!body.humanVerified) {
      return json({ error: "Human check required before voting" }, 403);
    }

    const mpId = String(body.mpId || "").toLowerCase().trim();
    const sentiment = String(body.sentiment || "").toLowerCase().trim();
    if (!mpId || (sentiment !== "favourable" && sentiment !== "unfavourable")) {
      return json({ error: "mpId and sentiment required" }, 400);
    }

    const repo = env.GITHUB_REPO || "FlavourThink/nz-politics-workers-collection";
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "nz-politics-vote-door"
      },
      body: JSON.stringify({
        event_type: "vote_cast",
        client_payload: {
          mpId,
          sentiment,
          secret: env.VOTE_WEBHOOK_SECRET
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return json({ error: "GitHub dispatch failed", detail: text }, 502);
    }
    return json({ ok: true });
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() }
  });
}
