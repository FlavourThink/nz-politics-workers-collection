/**
 * News worker — NZ political headlines
 * Uses NewsAPI + World News API when keys exist; always tries RSS fallbacks.
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "news.json");

const NEWS_API_KEY = process.env.NEWS_API_KEY || "";
const WORLD_NEWS_API_KEY = process.env.WORLD_NEWS_API_KEY || "";

const MP_HINTS = [
  "luxon", "hipkins", "peters", "seymour", "swarbrick", "willis", "ardern",
  "parliament", "beehive", "national party", "labour party", "act party",
  "nz first", "greens", "te pati maori", "prime minister", "minister"
];

const CONTROVERSY_HINTS = [
  "scandal", "controversy", "backlash", "resign", "apology", "racist",
  "misconduct", "investigation", "criticis", "outrage", "condemn"
];

function norm(s) {
  return String(s || "").toLowerCase();
}

function looksPolitical(title, description) {
  const t = norm(title) + " " + norm(description);
  return MP_HINTS.some((h) => t.includes(h)) || CONTROVERSY_HINTS.some((h) => t.includes(h));
}

function articleKey(a) {
  return (a.url || a.title || "").trim().toLowerCase();
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fromNewsApi() {
  if (!NEWS_API_KEY) return [];
  const url =
    "https://newsapi.org/v2/top-headlines?country=nz&language=en&pageSize=50&apiKey=" +
    encodeURIComponent(NEWS_API_KEY);
  const data = await fetchJson(url);
  const list = data.articles || [];
  return list.map((a) => ({
    title: a.title || "",
    description: a.description || "",
    url: a.url || "",
    source: a.source?.name || "NewsAPI",
    publishedAt: a.publishedAt || null,
    via: "newsapi"
  }));
}

async function fromWorldNews() {
  if (!WORLD_NEWS_API_KEY) return [];
  // text filter leans political; API shapes vary by plan
  const url =
    "https://api.worldnewsapi.com/search-news?source-countries=nz&language=en&number=50&text=politics%20OR%20parliament%20OR%20minister&api-key=" +
    encodeURIComponent(WORLD_NEWS_API_KEY);
  const data = await fetchJson(url);
  const list = data.news || data.articles || [];
  return list.map((a) => ({
    title: a.title || "",
    description: a.summary || a.text || a.description || "",
    url: a.url || a.link || "",
    source: a.source || a.authors?.[0] || "WorldNewsAPI",
    publishedAt: a.publish_date || a.publishedAt || null,
    via: "worldnewsapi"
  }));
}

async function fromRssProxy(feedUrl, label) {
  // Public proxy — fine for Actions; rate limits possible
  const proxy =
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(feedUrl);
  const res = await fetch(proxy);
  if (!res.ok) throw new Error(`RSS proxy ${res.status} ${label}`);
  const xml = await res.text();
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks.slice(0, 30)) {
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || "";
    const link = (block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || "";
    const desc = (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] || "";
    const pub = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || [])[1] || null;
    items.push({
      title: title.replace(/<[^>]+>/g, "").trim(),
      description: desc.replace(/<[^>]+>/g, "").trim().slice(0, 400),
      url: link.trim(),
      source: label,
      publishedAt: pub,
      via: "rss"
    });
  }
  return items;
}

async function main() {
  const collected = [];
  const errors = [];

  for (const [name, fn] of [
    ["newsapi", fromNewsApi],
    ["worldnews", fromWorldNews],
    ["rnz", () => fromRssProxy("https://www.rnz.co.nz/rss/political.xml", "RNZ")],
    ["scoop", () => fromRssProxy("https://www.scoop.co.nz/feeds/ie/politics.rss", "Scoop")]
  ]) {
    try {
      const rows = await fn();
      console.log(`${name}: ${rows.length} items`);
      collected.push(...rows);
    } catch (e) {
      console.warn(`${name} failed:`, e.message || e);
      errors.push({ source: name, error: String(e.message || e) });
    }
  }

  const seen = new Set();
  const articles = [];
  for (const a of collected) {
    if (!a.title || !a.url) continue;
    const k = articleKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    // Prefer political / controversy-ish; still keep some general NZ top lines
    a.politicalLikely = looksPolitical(a.title, a.description);
    articles.push(a);
  }

  articles.sort((a, b) => {
    if (a.politicalLikely !== b.politicalLikely) return a.politicalLikely ? -1 : 1;
    return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "nz-politics-workers-collection/news",
    count: articles.length,
    errors,
    articles: articles.slice(0, 80)
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.count} articles → data/news.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
