/**
 * Site updater — merge news + polls + votes into data/latest.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

function readJson(name, fallback) {
  const p = join(dataDir, name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function main() {
  const news = readJson("news.json", { updatedAt: null, articles: [] });
  const polls = readJson("polls.json", { updatedAt: null, polls: [] });
  const votes = readJson("votes.json", { updatedAt: null, byMp: {} });
  const mps = readJson("mps.json", { updatedAt: null, members: [] });

  let totalFavourable = 0;
  let totalUnfavourable = 0;
  const byMp = votes.byMp || {};
  for (const id of Object.keys(byMp)) {
    totalFavourable += Number(byMp[id].favourable) || 0;
    totalUnfavourable += Number(byMp[id].unfavourable) || 0;
  }

  const latest = {
    updatedAt: new Date().toISOString(),
    news: {
      updatedAt: news.updatedAt || null,
      count: (news.articles || []).length,
      articles: (news.articles || []).slice(0, 40)
    },
    polls: {
      updatedAt: polls.updatedAt || null,
      count: (polls.polls || []).length,
      polls: (polls.polls || []).slice(0, 30),
      source: polls.source || null
    },
    votes: {
      updatedAt: votes.updatedAt || null,
      byMp
    },
    mps: {
      updatedAt: mps.updatedAt || null,
      activeCount: mps.activeCount || (mps.members || []).filter(function(m){return m.status==="active";}).length,
      members: mps.members || []
    },
    stats: {
      articleCount: (news.articles || []).length,
      pollCount: (polls.polls || []).length,
      mpsWithVotes: Object.keys(byMp).length,
      totalFavourable,
      totalUnfavourable
    }
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "latest.json"), JSON.stringify(latest, null, 2));
  console.log("Wrote data/latest.json", latest.stats);
}

main();
