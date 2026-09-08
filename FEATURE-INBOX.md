# Feature inbox worker

POST { title, detail } appends to FlavourThink/nz-politics/feature-requests.json.

1. Fine-grained PAT: Contents read/write on FlavourThink/nz-politics
2. npm i -g wrangler
3. npx wrangler login
4. npx wrangler secret put GITHUB_TOKEN --config wrangler.features.toml
5. npx wrangler deploy --config wrangler.features.toml
6. Set FEATURE_API in atlas.js to the workers.dev URL printed
