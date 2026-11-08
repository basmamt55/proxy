/**
 * DivHard media proxy — Cloudflare Worker.
 *
 * PHP mints a short-lived token. This Worker fetches the upstream file with
 * the player's Referer, rewrites HLS when the CDN allows Cloudflare, and
 * asks the origin to pull a copy when Cloudflare is refused.
 *
 * Token format (URL-safe, no padding):
 *   /p/{base64url(JSON payload)}
 * A legacy "/p/{body}.{signature}" token is still accepted. The signature
 * is ignored. There is no shared secret.
 *
 * Payload: { u, r, k, e, f? }
 *   u upstream URL
 *   r page Referer
 *   k "hls"|"file"|"text"|"img"
 *   e expiry (unix seconds)
 *   f origin /api/media.php URL used only after a Cloudflare refusal
 */

const VERSION = 4;
const TOKEN_TTL = 86400;
const PLAYLIST_CACHE_SECONDS = 5;
const FILE_CACHE_SECONDS = 21600;
const TEXT_CACHE_SECONDS = 600;
const IMAGE_CACHE_SECONDS = 3600;
const FILE_CACHE_MAX = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const finalUrls = new WeakMap();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ACCEPT_LANGUAGE = 'en-US,en;q=0.9,ar;q=0.8';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, If-None-Match, If-Modified-Since',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'divhard-media-proxy', version: VERSION, ready: true });
      }

      if (url.pathname.startsWith('/p/')) {
        const token = decodeURIComponent(url.pathname.slice('/p/'.length));
        return await handleProxy(token, request, env, ctx);
      }

      return text('Not found', 404);
    } catch (error) {
      return text('Proxy error: ' + (error && error.message ? error.message : String(error)), 500);
    }
  },
};

async function handleProxy(token, request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Method not allowed', 405);
  }

  const payload = decodeToken(token);
  if (!payload) {
    return text('Invalid or expired media token', 403);
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(payload.u);
  } catch {
    return text('Invalid upstream URL', 400);
  }
  if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
    return text('Invalid upstream scheme', 400);
  }
  if (isBlockedHost(upstreamUrl.hostname, env)) {
    return text('Blocked upstream host', 403);
  }

  const kind = normaliseKind(payload.k, upstreamUrl.href);
  const referer = usefulReferer(payload.r);
  const fill = safeFillUrl(payload.f, env);
  const range = request.headers.get('range');
  const sendRange = range && !isWrappedImagePath(upstreamUrl.pathname);
  const cache = caches.default;
  const cacheKey = await buildCacheKey(kind, upstreamUrl.href, referer);
  const cacheable = !range && request.method === 'GET' && kind !== 'hls';

  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return withCors(hit);
    }
  }

  // PHP rewrites a playlist into child tokens that each carry their own fill
  // URL. The Worker cannot mint those, so a playlist with `f` is read from
  // the origin instead of being rewritten here.
  if (kind === 'hls' && fill) {
    const filled = await pipeFill(fill, request, kind, cache, cacheKey, ctx);
    if (filled) {
      return filled;
    }
    return text('Upstream fetch failed', 502);
  }

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, {
      method: request.method,
      referer,
      range: sendRange ? range : '',
      env,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (message === 'blocked-redirect') {
      return text('Blocked upstream host', 403);
    }
    if (message === 'too-many-redirects') {
      return text('Too many redirects', 502);
    }
    if (fill) {
      const filled = await pipeFill(fill, request, kind, cache, cacheKey, ctx);
      if (filled) {
        return filled;
      }
    }
    return text('Upstream fetch failed', 502);
  }

  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 304) {
    if ((upstream.status === 403 || upstream.status === 404) && fill) {
      await discard(upstream);
      const filled = await pipeFill(fill, request, kind, cache, cacheKey, ctx);
      if (filled) {
        return filled;
      }
    }
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    const failed = text('Upstream returned ' + upstream.status, status);
    failed.headers.set('x-upstream-status', String(upstream.status));
    return failed;
  }

  if (kind === 'hls') {
    return await handlePlaylist(upstream, payload, request);
  }

  if (request.method !== 'HEAD' && shouldUnwrap(kind, upstream)) {
    upstream = await unwrapPngTs(upstream);
  }

  return await handleFile(upstream, kind, cacheable, cache, cacheKey, ctx, false);
}

async function pipeFill(fillUrl, request, kind, cache, cacheKey, ctx) {
  const headers = new Headers();
  headers.set('accept', '*/*');
  headers.set('accept-encoding', 'identity');
  headers.set('user-agent', USER_AGENT);
  if (kind !== 'hls') {
    const range = request.headers.get('range');
    if (range && range.length <= 128) {
      headers.set('range', range);
    }
  }

  let response;
  try {
    response = await fetch(fillUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'manual',
    });
  } catch {
    return null;
  }

  if (response.status !== 200 && response.status !== 206 && response.status !== 304) {
    await discard(response);
    return null;
  }

  if (kind === 'hls') {
    const out = new Headers(CORS);
    out.set(
      'content-type',
      response.headers.get('content-type') || 'application/vnd.apple.mpegurl; charset=utf-8'
    );
    out.set('cache-control', 'no-store');
    out.set('x-proxy-kind', 'hls');
    out.set('x-proxy-fill', '1');
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers: out,
    });
  }

  return handleFile(response, kind, true, cache, cacheKey, ctx, true);
}

async function discard(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    /* the refused body is unused */
  }
}

async function fetchUpstream(startUrl, options) {
  let current = startUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (isBlockedHost(current.hostname, options.env)) {
      throw new Error('blocked-redirect');
    }
    const headers = new Headers();
    headers.set('accept', '*/*');
    headers.set('accept-encoding', 'identity');
    headers.set('accept-language', ACCEPT_LANGUAGE);
    headers.set('user-agent', USER_AGENT);
    if (options.referer) {
      headers.set('referer', options.referer);
      try {
        headers.set('origin', new URL(options.referer).origin);
      } catch {
        /* referer was checked already */
      }
    }
    if (options.range && !isWrappedImagePath(current.pathname)) {
      headers.set('range', options.range);
    }

    const response = await fetch(current.href, {
      method: options.method,
      headers,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return response;
      }
      current = new URL(location, current);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('blocked-redirect');
      }
      continue;
    }
    finalUrls.set(response, current.href);
    return response;
  }
  throw new Error('too-many-redirects');
}

function settledUrl(upstream, fallback) {
  return finalUrls.get(upstream) || upstream.url || fallback;
}

async function handlePlaylist(upstream, payload, request, env) {
  const body = await upstream.text();
  const clean = body.replace(/^\uFEFF/, '').trimStart();

  if (!clean.startsWith('#EXTM3U')) {
    const looksHtml = clean.startsWith('<');
    return text(
      looksHtml ? 'Upstream returned HTML instead of a playlist' : 'Playlist could not be read',
      502
    );
  }

  const base = settledUrl(upstream, payload.u);
  const rewritten = await rewritePlaylist(body, base, payload, request.url);

  const headers = new Headers(CORS);
  headers.set('content-type', 'application/vnd.apple.mpegurl; charset=utf-8');
  headers.set('cache-control', `public, max-age=${PLAYLIST_CACHE_SECONDS}`);
  headers.set('x-proxy-kind', 'hls');
  return new Response(rewritten, { status: 200, headers });
}

async function handleFile(upstream, kind, cacheable, cache, cacheKey, ctx, filled) {
  const headers = new Headers(CORS);
  for (const name of [
    'content-type',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  if (!upstream.headers.get('content-encoding')) {
    const length = upstream.headers.get('content-length');
    if (length) {
      headers.set('content-length', length);
    }
  }

  if (!headers.has('accept-ranges')) {
    headers.set('accept-ranges', 'bytes');
  }

  const ttl =
    kind === 'img'
      ? IMAGE_CACHE_SECONDS
      : kind === 'text'
        ? TEXT_CACHE_SECONDS
        : FILE_CACHE_SECONDS;

  headers.set('x-proxy-kind', kind);
  if (filled) {
    headers.set('x-proxy-fill', '1');
  }
  const store = cacheable && canStore(upstream);
  headers.set('cache-control', store ? `public, max-age=${ttl}` : 'no-store');

  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (store) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function canStore(upstream) {
  if (!upstream || upstream.status !== 200) return false;
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  if (type.includes('mpegurl') || type.includes('m3u8')) return false;
  const length = upstream.headers.get('content-length') || '';
  if (!/^\d+$/.test(length)) return false;
  const size = Number(length);
  return size > 0 && size <= FILE_CACHE_MAX;
}

function shouldUnwrap(kind, upstream) {
  if (kind !== 'file') return false;
  let path = '';
  try {
    path = new URL(settledUrl(upstream, 'https://invalid/')).pathname;
  } catch {
    path = '';
  }
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  return isWrappedImagePath(path) || type.startsWith('image/png');
}

async function unwrapPngTs(upstream) {
  if (!upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const chunks = [];
  let held = new Uint8Array(0);
  while (held.length < 512) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    held = concatBytes(held, step.value);
  }
  const skip = pngWrappedTsSkip(held);
  if (skip < 1) {
    const restored = prependStream(held, reader);
    return new Response(restored, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  const headers = new Headers(upstream.headers);
  headers.set('content-type', 'video/mp2t');
  headers.delete('content-range');
  const length = upstream.headers.get('content-length');
  if (length && /^\d+$/.test(length)) {
    const next = Math.max(0, Number(length) - skip);
    headers.set('content-length', String(next));
  }
  const rest = held.subarray(skip);
  return new Response(prependStream(rest, reader), {
    status: upstream.status === 206 ? 200 : upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function prependStream(prefix, reader) {
  return new ReadableStream({
    async start(controller) {
      if (prefix.length) controller.enqueue(prefix);
      try {
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          controller.enqueue(step.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function pngWrappedTsSkip(bytes) {
  if (bytes.length < 259) return 0;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return 0;
  }
  let iend = -1;
  const limit = Math.min(bytes.length - 4, 240);
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x44) {
      iend = i;
      break;
    }
  }
  if (iend < 0) return 0;
  const ts = iend + 8;
  if (bytes.length <= ts + 188) return 0;
  if (bytes[ts] !== 0x47 || bytes[ts + 188] !== 0x47) return 0;
  return ts;
}

function isWrappedImagePath(pathname) {
  return String(pathname || '').toLowerCase().endsWith('.image');
}

async function rewritePlaylist(body, baseUrl, payload, requestUrl) {
  const origin = new URL(requestUrl).origin;
  const now = Math.floor(Date.now() / 1000);
  const parentExp = typeof payload.e === 'number' ? payload.e : now + TOKEN_TTL;
  const childExp = Math.max(Math.min(parentExp, now + TOKEN_TTL), now + 300);

  const makeUrl = async (reference) => {
    let absolute;
    try {
      absolute = new URL(decodeEntities(reference), baseUrl).href;
    } catch {
      return reference;
    }
    const childKind = isPlaylistUrl(absolute) ? 'hls' : payload.k === 'text' ? 'text' : 'file';
    const childToken = encodeToken({
      u: absolute,
      r: payload.r || '',
      k: childKind,
      e: childExp,
    });
    return origin + '/p/' + childToken;
  };

  const lines = body.split(/\r\n|\n|\r/);
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push('');
      continue;
    }

    if (trimmed.startsWith('#')) {
      let replaced = line;
      const matches = [...line.matchAll(/URI=(["'])(.*?)\1/gi)];
      for (const match of matches) {
        const proxied = await makeUrl(match[2]);
        replaced = replaced.replace(match[0], () => 'URI="' + proxied + '"');
      }
      out.push(replaced);
      continue;
    }

    out.push(await makeUrl(trimmed));
  }

  return out.join('\n') + '\n';
}

function normaliseKind(kind, url) {
  if (kind === 'hls' || kind === 'file' || kind === 'text' || kind === 'img') {
    return kind;
  }
  return isPlaylistUrl(url) ? 'hls' : 'file';
}

function isPlaylistUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.m3u') || /\.m3u8?(\?|$)/i.test(url);
  } catch {
    return false;
  }
}

function usefulReferer(value) {
  if (typeof value !== 'string') return '';
  const referer = value.trim();
  if (!/^https?:\/\/\S+$/i.test(referer)) return '';
  if (referer.length > 2000) return '';
  return referer;
}

async function buildCacheKey(kind, url, referer) {
  const hash = await sha256Hex(kind + '\n' + url + '\n' + referer);
  return new Request('https://cache.divhard.internal/' + kind + '/' + hash, { method: 'GET' });
}

function decodeToken(token) {
  if (typeof token !== 'string' || token === '' || token.length > 12000) {
    return null;
  }
  const dot = token.indexOf('.');
  const body = dot === -1 ? token : token.slice(0, dot);
  if (body === '') {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }

  if (!payload || typeof payload.u !== 'string' || payload.u === '') {
    return null;
  }
  if (typeof payload.e === 'number' && payload.e < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (payload.f != null && typeof payload.f !== 'string') {
    payload.f = '';
  }
  return payload;
}

function encodeToken(payload) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function safeFillUrl(value, env) {
  if (typeof value !== 'string' || value === '' || value.length > 4000) {
    return '';
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.username || url.password) {
    return '';
  }
  if (url.pathname !== '/api/media.php') {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'ex.divhard.com' || host === 'www.ex.divhard.com') {
    return url.protocol === 'https:' ? url.href : '';
  }
  const extra = env && env.FILL_HOST ? String(env.FILL_HOST).toLowerCase() : '';
  if (extra && host === extra && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return url.href;
  }
  return '';
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  let normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalised.length % 4 !== 0) {
    normalised += '=';
  }
  const binary = atob(normalised);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isBlockedHost(hostname, env) {
  if (isMetadataHostname(hostname)) return true;
  if (env && env.ALLOW_PRIVATE_HOSTS === '1') return false;
  return isPrivateHostname(hostname);
}

function isMetadataHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal')) return true;
  return /^169\.254\./.test(host);
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0'
  ) {
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  if (/^169\.254\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) {
    return true;
  }
  return false;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function concatBytes(left, right) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(value, status = 200) {
  const headers = new Headers(CORS);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers });
}

function text(value, status = 200) {
  const headers = new Headers(CORS);
  headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(value, { status, headers });
}
