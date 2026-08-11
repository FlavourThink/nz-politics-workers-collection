/**
 * MPs worker — daily roster of New Zealand Members of Parliament
 * Writes data/mps.json for the website (active filter, ranks, parties, dates).
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "mps.json");

const SOURCES = [
  "https://en.wikipedia.org/wiki/List_of_MPs_elected_in_the_2023_New_Zealand_general_election",
  "https://en.wikipedia.org/wiki/New_Zealand_House_of_Representatives"
];

function slugify(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function partyNorm(raw) {
  const t = stripTags(raw).toLowerCase();
  if (/national/.test(t)) return "National";
  if (/labour/.test(t)) return "Labour";
  if (/green/.test(t)) return "Green";
  if (/\bact\b/.test(t)) return "ACT";
  if (/nz first|new zealand first/.test(t)) return "NZ First";
  if (/m[aā]ori|te pāti/.test(t)) return "Te Pāti Māori";
  if (/\btop\b|opportunities/.test(t)) return "TOP";
  if (/independent/.test(t)) return "Independent";
  return stripTags(raw).slice(0, 40) || "Unknown";
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "nz-politics-workers-collection/1.0 (mp roster; daily)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function parseElectionTable(html) {
  const members = [];
  // Split wiki tables
  const tables = html.split(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>/i).slice(1);
  tables.forEach((table) => {
    const rows = table.split(/<tr[\s>]/i).slice(1);
    rows.forEach((row) => {
      if (/<th[\s>]/i.test(row) && !/<td[\s>]/i.test(row)) return;
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let m;
      while ((m = cellRe.exec(row))) cells.push(stripTags(m[1]));
      if (cells.length < 3) return;
      // Heuristic: name often in first or second cell; party nearby
      let name = cells.find((c) => /^[A-ZĀĒĪŌŪ][\p{L}'\-]+(?:\s+[A-ZĀĒĪŌŪ][\p{L}'\-]+)+$/u.test(c)) || cells[0];
      if (!name || name.length < 5 || name.length > 60) return;
      if (/^(electorate|list|party|name|member|rank)/i.test(name)) return;
      const partyCell = cells.find((c) =>
        /national|labour|green|\bact\b|first|māori|maori|opportunities|independent/i.test(c)
      ) || cells[2] || "";
      const electorate = cells.find((c) =>
        /list|electorate|north|south|central|bay|city|coast|harbour|heights|park/i.test(c)
      ) || "";
      const id = slugify(name);
      if (!id) return;
      members.push({
        id,
        name,
        party: partyNorm(partyCell),
        electorate: electorate.slice(0, 60) || null,
        status: "active",
        termStart: 2023,
        termEnd: null,
        listRank: null,
        source: "wikipedia-2023-election-table"
      });
    });
  });
  return members;
}

function dedupeMembers(list) {
  const byId = new Map();
  list.forEach((m) => {
    const prev = byId.get(m.id);
    if (!prev) byId.set(m.id, m);
    else {
      byId.set(m.id, {
        ...prev,
        ...m,
        party: m.party && m.party !== "Unknown" ? m.party : prev.party
      });
    }
  });
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadPrevious() {
  if (!existsSync(outPath)) return null;
  try {
    return JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const collected = [];
  const errors = [];
  for (const url of SOURCES) {
    try {
      const html = await fetchText(url);
      const parsed = parseElectionTable(html);
      console.log(url, "→", parsed.length, "rows");
      collected.push(...parsed);
    } catch (e) {
      console.warn(url, e.message || e);
      errors.push({ url, error: String(e.message || e) });
    }
  }

  let members = dedupeMembers(collected);
  const prev = loadPrevious();
  // Preserve approval history series if present
  const prevApproval = (prev && prev.approvalSeries) || {};
  const prevById = {};
  (prev && prev.members ? prev.members : []).forEach((m) => {
    prevById[m.id] = m;
  });

  members = members.map((m) => {
    const old = prevById[m.id] || {};
    return {
      ...old,
      ...m,
      firstSeen: old.firstSeen || new Date().toISOString().slice(0, 10),
      lastSeen: new Date().toISOString().slice(0, 10),
      status: m.status || old.status || "active"
    };
  });

  // Mark previous members missing this run as possibly inactive (don't delete)
  const currentIds = new Set(members.map((m) => m.id));
  Object.keys(prevById).forEach((id) => {
    if (!currentIds.has(id)) {
      const old = prevById[id];
      members.push({
        ...old,
        status: "inactive",
        termEnd: old.termEnd || new Date().toISOString().slice(0, 4),
        lastSeen: old.lastSeen || null
      });
    }
  });
  members = dedupeMembers(members);

  const payload = {
    updatedAt: new Date().toISOString(),
    source: SOURCES[0],
    count: members.length,
    activeCount: members.filter((m) => m.status === "active").length,
    members,
    approvalSeries: prevApproval,
    errors,
    note:
      "Daily roster snapshot from public Wikipedia tables. Cross-check Parliament website for official ranks. Used to filter news to active MPs."
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${payload.activeCount} active / ${payload.count} total → data/mps.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
