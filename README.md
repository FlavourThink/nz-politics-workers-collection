# nz-politics-workers-collection

Four GitHub Actions workers that feed the NZ Politics website.

| Worker | Schedule | Output |
|--------|----------|--------|
| **News** | Every 3 hours | `data/news.json` |
| **Polls** | Once a day (06:00 UTC) | `data/polls.json` |
| **Votes** | On each vote (`repository_dispatch`) | `data/votes.json` |
| **Site updater** | After any of the above finishes | `data/latest.json` |

## Secrets (Repo → Settings → Secrets and variables → Actions)

| Name | Required | Purpose |
|------|----------|---------|
| `NEWS_API_KEY` | Optional | newsapi.org key |
| `WORLD_NEWS_API_KEY` | Optional | World News API key |
| `VOTE_WEBHOOK_SECRET` | Yes for votes | Shared secret so only your vote-door can trigger the votes worker |
| `GITHUB_TOKEN` | Automatic | Provided by Actions (do not add manually) |

Never put API keys in this repo or in the public website.

## Vote door (plain English)

Your website is static files. It **must not** hold a GitHub password/token.

The **vote door** is a tiny free service (e.g. Cloudflare Worker) that:

1. Receives the vote from the browser  
2. Checks the visitor completed the human check  
3. Checks a private secret  
4. Asks GitHub to run the **Votes** worker  

Without that door, “save everyone’s votes in GitHub” is not safe.

## First-time setup

1. Upload these files to `https://github.com/FlavourThink/nz-politics-workers-collection`  
2. Add secrets (above)  
3. Actions tab → enable workflows if prompted  
4. Run **News** and **Polls** once manually to create data files  
5. Later: add the vote-door + wire the main site to `data/latest.json`

## Manual test

- Actions → **News headlines** → Run workflow  
- Actions → **Opinion polls** → Run workflow  
- After either finishes, **Site updater** should run automatically  
