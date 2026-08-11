/**
 * Votes worker — apply one vote event to data/votes.json
 * Triggered via repository_dispatch with client_payload:
 *   { mpId, sentiment: "favourable"|"unfavourable", secret }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "votes.json");

const expectedSecret = process.env.VOTE_WEBHOOK_SECRET || "";
const mpId = (process.env.VOTE_MP_ID || "").trim().toLowerCase();
const sentiment = (process.env.VOTE_SENTIMENT || "").trim().toLowerCase();
const providedSecret = process.env.VOTE_PROVIDED_SECRET || "";

function loadVotes() {
  if (!existsSync(outPath)) {
    return { updatedAt: null, byMp: {} };
  }
  try {
    return JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    return { updatedAt: null, byMp: {} };
  }
}

function main() {
  if (!expectedSecret) {
    console.error("VOTE_WEBHOOK_SECRET is not set in repo secrets");
    process.exit(1);
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    console.error("Invalid vote secret — refusing to update");
    process.exit(1);
  }
  if (!mpId || !/^[a-z0-9_-]{1,64}$/.test(mpId)) {
    console.error("Invalid mpId");
    process.exit(1);
  }
  if (sentiment !== "favourable" && sentiment !== "unfavourable") {
    console.error("sentiment must be favourable or unfavourable");
    process.exit(1);
  }

  const data = loadVotes();
  if (!data.byMp) data.byMp = {};
  if (!data.byMp[mpId]) data.byMp[mpId] = { favourable: 0, unfavourable: 0 };

  data.byMp[mpId][sentiment] = (Number(data.byMp[mpId][sentiment]) || 0) + 1;
  data.updatedAt = new Date().toISOString();
  data.lastVote = { mpId, sentiment, at: data.updatedAt };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Recorded ${sentiment} for ${mpId}`);
}

main();
