/**
 * MPs worker — daily NZ Members of Parliament roster
 * Source: Wikipedia 54th New Zealand Parliament member tables
 * Fields: name, party, electorate/list, rank, term start/end, status
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "mps.json");
const WIKI_54 = "https://en.wikipedia.org/wiki/54th_New_Zealand_Parliament";

function slugify(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(rt\.?\s*hon\.?|hon\.?)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 48);
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function partyNorm(raw) {
  const t = String(raw || "").toLowerCase();
  if (t.includes("national")) return "National";
  if (t.includes("labour")) return "Labour";
  if (t.includes("green")) return "Green";
  if (t.includes("act")) return "ACT";
  if (t.includes("first")) return "NZ First";
  if (t.includes("māori") || t.includes("maori") || t.includes("pāti") || t.includes("pati"))
    return "Te Pāti Māori";
  if (t.includes("independent")) return "Independent";
  return "Unknown";
}

function parseTerm(termStr) {
  const s = String(termStr || "");
  const years = [...s.matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
  const termStart = years.length ? years[0] : 2023;
  const open = /present/i.test(s) || /[–-]\s*$/.test(s.trim());
  return {
    termStart,
    termEnd: open ? null : years.length > 1 ? years[years.length - 1] : null,
    termRaw: s.slice(0, 100),
    status: "active"
  };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "nz-politics-workers-collection/1.2 (MP roster; educational; GitHub FlavourThink)"
    }
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.text();
}

function parseWiki54(html) {
  const start = html.indexOf('id="Members"');
  const chunk = start >= 0 ? html.slice(start) : html;
  const members = [];
  const rowRe =
    /<td[^>]*>\s*(\d{1,2})\s*<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>\s*<a[^>]+title="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;

  let m;
  while ((m = rowRe.exec(chunk))) {
    const rank = Number(m[1]);
    const title = m[2];
    let name = m[3].trim();
    const elecHtml = m[4];
    const termHtml = m[5];

    if (/party|electorate|file:/i.test(title)) continue;
    if (/^(National|Labour|Green|ACT|Independent|Te Pāti)/i.test(name)) continue;
    if (name.length < 5 || name.length > 60) continue;

    const termStr = stripTags(termHtml);
    if (!/(19|20)\d{2}/.test(termStr)) continue;

    const am = elecHtml.match(/<a[^>]+>([^<]+)<\/a>/i);
    let electorate = am ? am[1].trim() : stripTags(elecHtml);
    if (!electorate || electorate === "—" || electorate === "-") electorate = "List";

    const before = chunk.slice(Math.max(0, m.index - 4000), m.index);
    const parties = before.match(
      /New Zealand National Party|New Zealand Labour Party|Green Party of Aotearoa New Zealand|ACT New Zealand|New Zealand First|Te Pāti Māori|Independent politician/g
    );
    const party = partyNorm(parties && parties.length ? parties[parties.length - 1] : "");

    const term = parseTerm(termStr);
    members.push({
      id: slugify(name),
      name,
      party,
      electorate,
      listRank: rank,
      termStart: term.termStart,
      termEnd: term.termEnd,
      termRaw: term.termRaw,
      status: "active",
      source: "wikipedia-54th-parliament"
    });
  }
  return members;
}

function dedupe(list) {
  const map = new Map();
  for (const m of list) {
    if (!m.id) continue;
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...prev, ...m, party: m.party !== "Unknown" ? m.party : prev.party } : m);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadPrev() {
  if (!existsSync(outPath)) return null;
  try {
    return JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const errors = [];
  let members = [];
  try {
    const html = await fetchText(WIKI_54);
    members = parseWiki54(html);
    console.log("Parsed", members.length, "MPs from Wikipedia 54th Parliament");
  // Fix common mis-parses from complex wiki templates
  const hardFixes = {
    christopherluxon: { party: "National", listRank: 1, electorate: "Botany" },
    gerrybrownlee: { party: "National", electorate: "List", listRank: 20, status: "active", termEnd: null },
    rthongerrybrownlee: { party: "National", electorate: "List", status: "active", termEnd: null }
  };
  members = members.map((m) => {
    const fix = hardFixes[m.id] || hardFixes[slugify(m.name)];
    if (!fix) return m;
    return { ...m, ...fix };
  }).filter((m) => m.electorate && !String(m.electorate).includes("text-align") && m.party !== "Unknown");

  } catch (e) {
    errors.push({ source: WIKI_54, error: String(e.message || e) });
    throw e;
  }

  members = dedupe(members);
  const prev = loadPrev();
  const prevById = {};
  ((prev && prev.members) || []).forEach((m) => {
    prevById[m.id] = m;
  });
  const today = new Date().toISOString().slice(0, 10);

  members = members.map((m) => ({
    ...(prevById[m.id] || {}),
    ...m,
    firstSeen: (prevById[m.id] && prevById[m.id].firstSeen) || today,
    lastSeen: today,
    status: "active"
  }));

  const current = new Set(members.map((m) => m.id));
  Object.keys(prevById).forEach((id) => {
    if (!current.has(id) && prevById[id].status === "active") {
      members.push({
        ...prevById[id],
        status: "inactive",
        termEnd: prevById[id].termEnd || new Date().getFullYear()
      });
    }
  });
  members = dedupe(members);

  const byParty = {};
  members
    .filter((m) => m.status === "active")
    .forEach((m) => {
      byParty[m.party] = (byParty[m.party] || 0) + 1;
    });

  const activeCount = members.filter((m) => m.status === "active").length;
  const payload = {
    updatedAt: new Date().toISOString(),
    source: WIKI_54,
    count: members.length,
    activeCount,
    byParty,
    members,
    approvalSeries: (prev && prev.approvalSeries) || {},
    errors,
    note:
      "Daily roster from Wikipedia 54th NZ Parliament member tables (rank, name, electorate/list, term, party). Official current-MP CSV also exists at data.govt.nz but is often blocked from cloud IPs. Cross-check parliament.nz for roles."
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log("Wrote active=" + activeCount + " byParty=" + JSON.stringify(byParty));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
