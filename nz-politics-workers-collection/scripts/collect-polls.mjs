/**
 * Polls worker — snapshot of 2026 NZ election opinion polls
 * Primary: Wikipedia page tables (public). No API key required.
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "polls.json");
const WIKI =
  "https://en.wikipedia.org/wiki/Opinion_polling_for_the_2026_New_Zealand_general_election";

async function main() {
  const res = await fetch(WIKI, {
    headers: { "User-Agent": "nz-politics-workers-collection/1.0 (poll snapshot)" }
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const html = await res.text();

  // Lightweight extract: keep raw table snippets for the site updater / UI to parse,
  // plus a few numeric rows when patterns match.
  const polls = [];
  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>([\s\S]*?)<\/tr>/gi;
  let m;
  let guard = 0;
  while ((m = rowRe.exec(html)) && guard < 200) {
    guard++;
    const firm = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const dates = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const rest = m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!firm || firm.length > 80) continue;
    if (/pollster|fieldwork|sample|national/i.test(firm) && /party/i.test(rest)) continue;
    const nums = rest.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length < 3) continue;
    polls.push({
      firm,
      dates,
      rawNumbers: nums.slice(0, 12).map(Number),
      note: "Parsed from Wikipedia HTML; verify against source page"
    });
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: WIKI,
    count: polls.length,
    polls: polls.slice(0, 40),
    disclaimer:
      "Unofficial scrape of publicly listed polls. Always check the original pollster and Wikipedia."
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.count} poll rows → data/polls.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
