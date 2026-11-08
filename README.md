# DivHard media proxy (Cloudflare Worker)

Optional playback proxy. PHP mints a short-lived unsigned token. The Worker
fetches the upstream media, rewrites HLS playlists when the CDN allows
Cloudflare, and asks the origin to pull a copy when Cloudflare is refused.
Complete files of 25MB or less are cached at the edge. Playlists are not.

## Local development

```powershell
npm install
npm run dev        # http://127.0.0.1:8787
npm test           # needs PHP available (set PHP_BIN if php is not on PATH)
```

The PHP side enables it through `config.local.php`:

```php
'worker_proxy' => [
    'url' => 'http://127.0.0.1:8787',
    'ttl' => 86400,
],
```

## Auto-deploy from GitHub

This repo ships `.github/workflows/deploy.yml`. To make pushes deploy automatically:

1. In GitHub: **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + Account:Read)
   - `CLOUDFLARE_ACCOUNT_ID`
2. Push to `main`. The workflow deploys when the API token is present.
   It does not create a `PROXY_SECRET` binding.
3. Cloudflare prints the `https://…workers.dev` URL in the run log. Paste it
   into **Admin → Workers** (or `config.php`) on the PHP side.

## Playback

The admin Workers page on the player lists this Worker's `https://….workers.dev`
address. Checked media hosts are the only ones sent through the Worker. An
empty media-host list sends every host. `/health` reports `ready: true`
without a shared secret. The player keeps an origin fallback. When a CDN
returns 403 or 404, or the connection fails, the Worker streams the origin
copy and the viewer still receives the bytes from Cloudflare.

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
