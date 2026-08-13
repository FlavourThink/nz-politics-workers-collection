/**
 * News worker — NZ political headlines
 * NewsAPI + World News API (optional keys) + many RSS feeds in parallel.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
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
  "misconduct", "investigation", "criticis", "outrage", "condemn", "under fire"
];

const RSS_FEEDS = [
  { url: "https://www.rnz.co.nz/rss/political.xml", source: "RNZ" },
  { url: "https://www.rnz.co.nz/rss/national.xml", source: "RNZ" },
  { url: "https://www.rnz.co.nz/rss/news.xml", source: "RNZ" },
  { url: "https://www.scoop.co.nz/feeds/ie/politics.rss", source: "Scoop" },
  { url: "https://news.google.com/rss/search?q=site:1news.co.nz+(politics+OR+Parliament+OR+Luxon+OR+Peters)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "1News" },
  { url: "https://news.google.com/rss/search?q=site:nzherald.co.nz+(politics+OR+Parliament+OR+Luxon)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "NZ Herald" },
  { url: "https://news.google.com/rss/search?q=site:stuff.co.nz+(politics+OR+Parliament)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "Stuff" },
  { url: "https://news.google.com/rss/search?q=site:thespinoff.co.nz+(politics+OR+Parliament)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "The Spinoff" },
  { url: "https://news.google.com/rss/search?q=site:newsroom.co.nz+(politics+OR+Parliament)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "Newsroom" },
  { url: "https://news.google.com/rss/search?q=site:thepost.co.nz+(politics+OR+Parliament)&hl=en-NZ&gl=NZ&ceid=NZ:en", source: "The Post" }
];

const PROXIES = [
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://corsproxy.io/?" + encodeURIComponent(u)
];

function norm(s) {
  return String(s || "").toLowerCase();
}

function looksPolitical(title, description) {
  const t = norm(title) + " " + norm(description);
  return MP_HINTS.some((h) => t.includes(h)) || CONTROVERSY_HINTS.some((h) => t.includes(h));
}

function articleKey(a) {
  let link = String(a.url || "").toLowerCase().trim().split("#")[0].split("?")[0].replace(/\/$/, "");
  if (link.length > 12) return "u:" + link;
  const title = String(a.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  const src = String(a.source || "").toLowerCase();
  return "s:" + src + "|" + title;
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
  return (data.articles || []).map((a) => ({
    title: a.title || "",
    description: a.description || "",
    url: a.url || "",
    source: a.source?.name || "NewsAPI",
    publishedAt: a.publishedAt || null,
    image: a.urlToImage || null,
    via: "newsapi"
  }));
}

async function fromWorldNews() {
  if (!WORLD_NEWS_API_KEY) return [];
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
    image: a.image || a.thumbnail || null,
    via: "worldnewsapi"
  }));
}

async function fetchTextViaProxies(feedUrl) {
  let lastErr = null;
  for (const build of PROXIES) {
    try {
      const res = await fetch(build(feedUrl), { redirect: "follow" });
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    const res = await fetch(feedUrl, {
      redirect: "follow",
      headers: { "User-Agent": "nz-politics-workers/1.0" }
    });
    if (!res.ok) throw new Error(`direct HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    throw lastErr || e;
  }
}

async function fromRssProxy(feedUrl, label) {
  const xml = await fetchTextViaProxies(feedUrl);
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks.slice(0, 40)) {
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || "";
    const link =
      (block.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] ||
      (block.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] ||
      "";
    const desc =
      (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1] ||
      "";
    const pub = (block.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || [])[1] || null;
    let image = null;
    const enc = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*(?:type=["']([^"']*)["'])?/i);
    if (enc && enc[1] && (/image/i.test(enc[2] || "") || /\.(jpg|jpeg|png|webp|gif)/i.test(enc[1]))) image = enc[1];
    if (!image) {
      const mc = block.match(/<media:content[^>]+url=["']([^"']+)["']/i);
      if (mc) image = mc[1];
    }
    if (!image) {
      const mt = block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
      if (mt) image = mt[1];
    }
    if (!image) {
      const im = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (im) image = im[1];
    }
    if (!image) {
      const encoded = (block.match(/<content:encoded[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i) || [])[1] || "";
      const im2 = encoded.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (im2) image = im2[1];
    }
    if (!image) {
      const thumb = (block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) || [])[1];
      if (thumb) image = thumb;
    }
    items.push({
      title: title.replace(/<[^>]+>/g, "").trim(),
      description: desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      url: link.trim(),
      source: label,
      publishedAt: pub,
      image: image,
      via: "rss"
    });
  }
  return items;
}


async function fetchHtml(pageUrl, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    clearTimeout(timer);
    if (!res.ok) return { url: pageUrl, html: null };
    const html = await res.text();
    return { url: res.url || pageUrl, html };
  } catch (_) {
    clearTimeout(timer);
    return { url: pageUrl, html: null };
  }
}

function parseOgImage(html) {
  if (!html) return null;
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let u = m[1].trim().replace(/&amp;/g, "&");
      if (u.indexOf("//") === 0) u = "https:" + u;
      if (/^https?:\/\//i.test(u)) return u;
    }
  }
  // first large-looking img in article body as last resort
  const imgs = html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi);
  for (const m of imgs) {
    let u = m[1].trim();
    if (u.indexOf("//") === 0) u = "https:" + u;
    if (!/^https?:\/\//i.test(u)) continue;
    if (/logo|icon|avatar|sprite|1x1|pixel|badge/i.test(u)) continue;
    if (/\.(jpg|jpeg|png|webp)/i.test(u) || /image/i.test(u)) return u;
  }
  return null;
}

async function extractOgImage(pageUrl) {
  try {
    let target = pageUrl;
    // Google News RSS links need resolving to the publisher article
    const first = await fetchHtml(target, 8000);
    let img = parseOgImage(first.html);
    if (img) return img;
    // Sometimes the page is an interstitial; try final URL again if different
    if (first.url && first.url !== target) {
      const second = await fetchHtml(first.url, 8000);
      img = parseOgImage(second.html);
      if (img) return img;
    }
  } catch (_) {}
  return null;
}

async function enrichMissingImages(articles, limit = 120) {
  const envLim = Number(process.env.ENRICH_LIMIT || limit);
  const need = articles.filter((a) => a && a.url && !a.image).slice(0, Math.max(0, envLim));
  console.log("Enriching og:image for", need.length, "articles without images");
  const concurrency = 10;
  let i = 0;
  async function worker() {
    while (i < need.length) {
      const idx = i++;
      const a = need[idx];
      const img = await extractOgImage(a.url);
      if (img) a.image = img;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const filled = articles.filter((a) => a.image).length;
  console.log("Articles with images after enrich:", filled, "/", articles.length);
  return articles;
}

async function main() {
  const started = Date.now();
  const errors = [];

  const jobs = [
    { name: "newsapi", run: fromNewsApi },
    { name: "worldnews", run: fromWorldNews },
    ...RSS_FEEDS.map((f, i) => ({
      name: "rss:" + f.source + ":" + i,
      run: () => fromRssProxy(f.url, f.source)
    }))
  ];

  const settled = await Promise.allSettled(
    jobs.map(async (j) => {
      const rows = await j.run();
      return { name: j.name, rows };
    })
  );

  const collected = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      console.log(r.value.name + ": " + r.value.rows.length + " items");
      collected.push(...r.value.rows);
    } else {
      const msg = String(r.reason && r.reason.message ? r.reason.message : r.reason || "failed");
      console.warn("job failed:", msg);
      errors.push({ error: msg });
    }
  }

  let previous = [];
  try {
    if (existsSync(outPath)) {
      const prev = JSON.parse(readFileSync(outPath, "utf8"));
      previous = prev.articles || [];
    }
  } catch (_) {}

  const seen = new Set();
  let articles = [];
  for (const a of collected.concat(previous)) {
    if (!a.title || !a.url) continue;
    const k = articleKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    a.politicalLikely = looksPolitical(a.title, a.description);
    articles.push(a);
  }

  articles.sort((a, b) => {
    if (a.politicalLikely !== b.politicalLikely) return a.politicalLikely ? -1 : 1;
    return String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
  });

  // Keep top 120 first, then fill feature images for every one of them
  articles = articles.slice(0, 120);

  try {
    // Enrich ALL saved articles that still lack an image (og:image from article page)
    articles = await enrichMissingImages(articles, articles.length);
  } catch (e) {
    console.warn("Image enrich failed (continuing without):", e && e.message ? e.message : e);
    errors.push({ error: "image-enrich: " + String(e && e.message ? e.message : e) });
  }

  const withImg = articles.filter((a) => a.image).length;
  console.log("Feature images ready:", withImg, "/", articles.length);

  const payload = {
    updatedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    source: "nz-politics-workers-collection/news",
    count: articles.length,
    images: withImg,
    errors,
    feedsTried: jobs.length,
    articles: articles
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log("Wrote " + payload.count + " articles -> data/news.json (" + payload.durationMs + "ms, " + errors.length + " errors)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
