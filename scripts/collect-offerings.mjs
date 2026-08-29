/**
 * Offerings worker — propose new 2026 planks.
 * Writes data/party-offerings-proposed.json only.
 * Does not overwrite data/party-offerings-2026.json (that file is accepted by hand).
 *
 * New lines land under: "Promises since MMM DD"
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
const livePath = join(dataDir, "party-offerings-2026.json");
const proposedPath = join(dataDir, "party-offerings-proposed.json");
const inboxPath = join(dataDir, "party-offerings-inbox.json");

const SOURCES = {
  National: ["https://www.national.org.nz/plan", "https://www.national.org.nz/news"],
  Labour: ["https://www.labour.org.nz/policy", "https://www.labour.org.nz/news"],
  Green: ["https://www.greens.org.nz/policy", "https://www.greens.org.nz/news"],
  ACT: ["https://www.act.org.nz/policies", "https://www.act.org.nz/news"],
  "NZ First": ["https://www.nzfirst.nz/", "https://www.nzfirst.nz/news"],
  "Te Pāti Māori": ["https://www.maoriparty.org.nz/", "https://www.maoriparty.org.nz/news"],
  TOP: ["https://www.top.org.nz/", "https://www.top.org.nz/news"]
};

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function sinceHeading(d = new Date()) {
  const mmm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `Promises since ${mmm} ${d.getUTCDate()}`;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9āēīōū+%$ ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function existingItems(partyBlock) {
  const out = new Set();
  for (const block of partyBlock.promises || []) {
    for (const it of block.items || []) out.add(norm(it));
  }
  return out;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
}

function extractCandidates(html) {
  const text = stripHtml(html);
  const chunks = [];
  const tagRe = /<(h[1-3]|li|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = tagRe.exec(text))) {
    const raw = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (raw.length < 28 || raw.length > 140) continue;
    if (/cookie|subscribe|sign in|javascript|browser|follow us|donate|newsletter|electorate office|stay up to date|latest announcements/i.test(raw)) continue;
    if (/^(economy|housing|health|education|tax) & /i.test(raw)) continue;
    chunks.push(raw);
  }
  const seen = new Set();
  return chunks.filter((c) => {
    const k = norm(c);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "nz-politics-workers-collection/1.0 (offerings snapshot; +https://github.com/FlavourThink/nz-politics-workers-collection)"
    }
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

async function candidatesFor(party) {
  const urls = SOURCES[party] || [];
  const found = [];
  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      found.push(...extractCandidates(html).slice(0, 8));
    } catch (err) {
      console.warn(party, url, err.message || err);
    }
  }
  return found;
}

function inboxItems(inbox, party) {
  const block = inbox.parties && inbox.parties[party];
  if (!block) return [];
  if (Array.isArray(block)) return block.map(String);
  return (block.items || []).map(String);
}

async function main() {
  const live = readJson(livePath, { parties: {} });
  const previous = readJson(proposedPath, { parties: {} });
  const inbox = readJson(inboxPath, { parties: {} });
  const heading = sinceHeading();
  const asAt = new Date().toISOString();

  const parties = Object.keys(SOURCES);
  const outParties = {};

  for (const name of parties) {
    const liveBlock = (live.parties && live.parties[name]) || { promises: [] };
    const known = existingItems(liveBlock);
    const prevBlock = (previous.parties && previous.parties[name]) || { promises: [] };
    for (const it of existingItems(prevBlock)) known.add(it);

    const scraped = await candidatesFor(name);
    const manual = inboxItems(inbox, name);
    const fresh = [];
    for (const line of [...manual, ...scraped]) {
      const k = norm(line);
      if (!k || known.has(k)) continue;
      known.add(k);
      fresh.push(line.trim());
    }

    const promises = (liveBlock.promises || []).map((b) => ({
      h: b.h,
      items: [...(b.items || [])]
    }));

    const already = promises.find((b) => b.h === heading);
    if (fresh.length) {
      if (already) {
        already.items.push(...fresh);
      } else {
        promises.push({ h: heading, items: fresh });
      }
    } else if (already) {
      // keep today's bucket if it already existed in live (unlikely)
    }

    // carry forward older "Promises since …" buckets from the last proposal
    for (const block of prevBlock.promises || []) {
      if (!/^Promises since /.test(block.h)) continue;
      if (promises.some((b) => b.h === block.h)) continue;
      const leftover = (block.items || []).filter((it) => !existingItems({ promises }).has(norm(it)));
      if (leftover.length) promises.push({ h: block.h, items: leftover });
    }

    outParties[name] = {
      promises,
      newCount: fresh.length
    };
  }

  const payload = {
    asAt,
    election: live.election || "2026-11-07",
    source: "proposed",
    heading,
    note: "Review these, then copy accepted items into data/party-offerings-2026.json. This file is a proposal only.",
    parties: outParties
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(proposedPath, JSON.stringify(payload, null, 2) + "\n");
  const added = Object.values(outParties).reduce((n, p) => n + (p.newCount || 0), 0);
  console.log(`Wrote ${proposedPath} · ${added} new item(s) under "${heading}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
