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

## Deploy

```powershell
npx wrangler login
npx wrangler secret put PROXY_SECRET
npm run deploy
```

Put the printed `https://...workers.dev` URL into `worker_proxy.url` (in
`config.php` on the production server) and keep the secrets in sync.

## Important limitation

The providers used by this app (cdn-video.xyz and similar) bind their media
tokens to the requesting IP. A Worker running on Cloudflare's edge fetches
with Cloudflare's egress IP and receives `403` from those CDNs. The Worker is
therefore useful for:

- local development (workerd uses the developer's own IP), and
- public streams that do not IP-bind (tests use test-streams.mux.dev).

For production with these providers, leave `worker_proxy.url` empty so the PHP
proxy at `/api/media.php` runs on the origin and fetches with the origin IP.
`Remote::request()` falls back to PHP's native stream wrapper when cURL cannot
complete the TLS handshake, which is what makes local playback work even
without the Worker.

## Files

- `src/index.js` — Worker entry point (token verify, fetch, HLS rewrite, cache).
- `test/proxy.test.mjs` — unit + integration tests against a mock origin.
- `test/mock-origin.mjs` — mock HLS origin.
- `test/php-token.php` — mints a token with the real PHP signer.
- `wrangler.toml` — deployment config.
- `.dev.vars` — local secrets (gitignored).
