# DivHard media proxy (Cloudflare Worker)

Optional playback proxy. PHP signs short-lived tokens; the Worker verifies the
HMAC, fetches the upstream media, rewrites HLS playlists so every child URL
comes back through the Worker, and caches segments at the edge.

## Local development

```powershell
npm install
npm run dev        # http://127.0.0.1:8787
npm test           # needs PHP available (set PHP_BIN if php is not on PATH)
```

The PHP side enables it through `config.local.php`:

```php
'worker_proxy' => [
    'url'    => 'http://127.0.0.1:8787',
    'secret' => '<same as PROXY_SECRET>',
    'ttl'    => 86400,
],
```

## Auto-deploy from GitHub

This repo ships `.github/workflows/deploy.yml`. To make pushes deploy automatically:

1. In GitHub: **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + Account:Read)
   - `CLOUDFLARE_ACCOUNT_ID`
   - `PROXY_SECRET` (same value as in the PHP admin / config)
2. Push to `main` — the workflow installs, syncs the secret, and deploys.
3. Cloudflare prints the new `https://…workers.dev` URL in the run log. Paste it
   into **Admin → Workers** (or `config.php`) on the PHP side.

Put the printed `https://...workers.dev` URL into `worker_proxy.url` (in
`config.php` on the production server) and keep the secrets in sync.

## Playback

The admin Workers page on the player lists this Worker's `https://….workers.dev`
address. Checked media hosts are the only ones sent through the Worker. An
empty media-host list sends every host. `/health` reports `ready` when
`PROXY_SECRET` is bound. The player uses the Worker only while that flag is
true, and keeps an origin fallback. If a CDN rejects Cloudflare's address,
that one play continues from `/api/media.php` on the origin.

The Worker follows redirects, sends the page Referer, and unwraps a PNG-wrapped
MPEG-TS segment. It does not receive playback cookies. A host that only answers
with an origin cookie still plays through the fallback.

## Local mock

Tests use a mock origin. `ALLOW_PRIVATE_HOSTS=1` is for that mock only. Do not
set it on the deployed Worker.

## Files

- `src/index.js` — Worker entry point (token verify, fetch, HLS rewrite, cache).
- `test/proxy.test.mjs` — unit + integration tests against a mock origin.
- `test/mock-origin.mjs` — mock HLS origin.
- `test/php-token.php` — mints a token with the real PHP signer.
- `wrangler.toml` — deployment config.
- `.dev.vars` — local secrets (gitignored).
