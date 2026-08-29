/**
 * Offerings worker — propose new 2026 planks from RNZ Election Policy Guide 2026.
 * Writes data/party-offerings-proposed.json only.
 *
 * Source: https://www.rnz.co.nz/news/politics_election-2026/feature/rnz-election-policy-guide-2026
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

const GUIDE_INDEX =
  "https://www.rnz.co.nz/news/politics_election-2026/feature/rnz-election-policy-guide-2026";
const GUIDE_PREFIX = "https://www.rnz.co.nz/news/politics_election-2026/feature/";

const FALLBACK_SLUGS = [
  "tax-policy-guide",
  "economy-policy-guide",
  "health-policy-guide",
  "education-policy-guide",
  "transport-policy-guide",
  "housing-policy-guide",
  "business-policy-guide",
  "crime-and-justice-policy-guide",
  "energy-climate-and-environment-policy-guide",
  "governance-policy-guide",
  "maori-issues-policy-guide",
  "welfare-family-youth-and-seniors-guide",
  "other-policy"
];

const PARTY_ALIAS = {
  national: "National",
  labour: "Labour",
  green: "Green",
  greens: "Green",
  "green party": "Green",
  act: "ACT",
  "nz first": "NZ First",
  "new zealand first": "NZ First",
  "te pati maori": "Te Pāti Māori",
  "te pāti māori": "Te Pāti Māori",
  "te pati māori": "Te Pāti Māori",
  opportunity: "TOP",
  "the opportunities party": "TOP",
  top: "TOP"
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
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9+$% ]/g, " ")
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

function cleanText(html) {
  return String(html || "")
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalParty(label) {
  return PARTY_ALIAS[norm(label)] || null;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "nz-politics-workers-collection/1.0 (RNZ policy guide snapshot)"
    }
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

function discoverTopicUrls(indexHtml) {
  const found = new Set(FALLBACK_SLUGS.map((s) => GUIDE_PREFIX + s));
  const re = /\/news\/politics_election-2026\/feature\/([a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(indexHtml))) {
    const slug = m[1];
    if (/rnz-election-policy-guide/.test(slug)) continue;
    found.add(GUIDE_PREFIX + slug);
  }
  return [...found];
}

function extractGuidePairs(html) {
  const pairs = [];
  const re =
    /<span class="font-sans-semibold[^"]*"[^>]*>([^<]+)<\/span>\s*<p class="[^"]*font-serif-text[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const party = canonicalParty(m[1]);
    const text = cleanText(m[2]);
    if (!party || text.length < 18 || text.length > 280) continue;
    if (/this guide will be updated/i.test(text)) continue;
    pairs.push({ party, text });
  }
  return pairs;
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

  let indexHtml = "";
  try {
    indexHtml = await fetchPage(GUIDE_INDEX);
  } catch (err) {
    console.warn("index", err.message || err);
  }
  const urls = discoverTopicUrls(indexHtml);
  console.log("Guide pages:", urls.length);

  const scraped = {
    National: [],
    Labour: [],
    Green: [],
    ACT: [],
    "NZ First": [],
    "Te Pāti Māori": [],
    TOP: []
  };

  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const rows = extractGuidePairs(html);
      console.log(url.split("/").pop(), rows.length);
      for (const row of rows) scraped[row.party].push(row.text);
    } catch (err) {
      console.warn(url, err.message || err);
    }
  }

  const parties = Object.keys(scraped);
  const outParties = {};

  for (const name of parties) {
    const liveBlock = (live.parties && live.parties[name]) || { promises: [] };
    const known = existingItems(liveBlock);
    const prevBlock = (previous.parties && previous.parties[name]) || { promises: [] };

    const fresh = [];
    for (const line of [...inboxItems(inbox, name), ...scraped[name]]) {
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
      if (already) already.items.push(...fresh);
      else promises.push({ h: heading, items: fresh });
    }

    for (const block of prevBlock.promises || []) {
      if (!/^Promises since /.test(block.h)) continue;
      if (promises.some((b) => b.h === block.h)) continue;
      const leftover = (block.items || []).filter((it) => !existingItems({ promises }).has(norm(it)));
      if (leftover.length) promises.push({ h: block.h, items: leftover });
    }

    outParties[name] = { promises, newCount: fresh.length };
  }

  const payload = {
    asAt,
    election: live.election || "2026-11-07",
    source: GUIDE_INDEX,
    heading,
    note: "Proposed from RNZ Election Policy Guide 2026. Copy accepted items into party-offerings-2026.json.",
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
