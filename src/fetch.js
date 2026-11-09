// Fetch layer: plain request first, FlareSolverr only when the response looks
// like a Cloudflare interstitial. Cookies + UA from a solve are reused so we
// don't pay for a browser round-trip on every request.

import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';

const UA_FALLBACK =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const env = (k, d = '') => (process.env[k] ?? d).trim();

let dispatcher = null;
let dispatcherTried = false;

// undici is an optionalDependency: without it we simply have no proxy support.
async function getDispatcher() {
  const proxy = env('PROXY_URL');
  if (!proxy) return null;
  if (dispatcherTried) return dispatcher;
  dispatcherTried = true;
  try {
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(proxy);
  } catch {
    console.warn('[fetch] PROXY_URL set but undici is unavailable — requests go out unproxied');
  }
  return dispatcher;
}

// The two ends of this pipeline want opposite exits, so the proxy is chosen
// per host rather than globally:
//
//   kinogo mirrors  -> direct. The site is blocked by Roskomnadzor, so a
//                      Russian exit cannot reach it at all (it times out even
//                      on robots.txt).
//   everything else -> proxied. The players are geo-locked to RU/CIS and their
//                      embed domains rotate, so allow-listing them is futile;
//                      anything that is not the site is treated as a player.
//
// Stream URLs are handed to Stremio untouched: the CDNs themselves are not
// geo-locked, so playback works from the viewer's own connection.
function isSiteHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/(^|\.)kinogo/i.test(host)) return true;
  return (process.env.KINOGO_MIRRORS || '')
    .split(',')
    .map((m) => {
      try {
        return new URL(m.trim()).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .includes(host);
}

export function shouldProxy(url) {
  return Boolean(env('PROXY_URL')) && !isSiteHost(url);
}

const PRIVATE_ADDRESSES = new BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) {
  PRIVATE_ADDRESSES.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
  PRIVATE_ADDRESSES.addSubnet(addr, bits, 'ipv6');
}

export class BlockedUrlError extends Error {}

async function assertPublic(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new BlockedUrlError(`blocked scheme: ${url}`);
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (addresses.some((a) => PRIVATE_ADDRESSES.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new BlockedUrlError(`blocked private address: ${url}`);
  }
}

const MAX_REDIRECTS = 5;

// These URLs come from third-party pages, so every redirect hop must be checked too.
export async function publicFetch(url, options) {
  let current = url;
  let hopOptions = options;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { ...hopOptions, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return { res, url: current };
    await res.body?.cancel();
    const next = new URL(location, current).href;
    if (new URL(next).origin !== new URL(current).origin) {
      const { Cookie, ...headers } = hopOptions.headers;
      hopOptions = { ...hopOptions, headers };
    }
    current = next;
  }
  throw new Error(`too many redirects: ${url}`);
}

// Per-origin browser identity handed back by FlareSolverr.
const identities = new Map(); // origin -> { cookie, userAgent, at }
const IDENTITY_TTL = 20 * 60 * 1000;

function identityFor(url) {
  const { origin } = new URL(url);
  const id = identities.get(origin);
  if (!id || Date.now() - id.at > IDENTITY_TTL) return null;
  return id;
}

const CHALLENGE_MARKERS = [
  'just a moment',
  'checking your browser',
  'cf-browser-verification',
  'cf_chl_opt',
  '_cf_chl',
  'enable javascript and cookies to continue',
];

// The players answer with a normal HTTP error plus this text when the exit IP
// is outside RU/CIS — it is not a challenge, and only a different exit fixes it.
const GEO_MARKERS = [
  'недоступно для вашего региона',
  'недоступен в вашем регионе',
  'not available in your region',
];

export function isGeoBlocked(body = '') {
  if (!body) return false;
  const low = body.slice(0, 8000).toLowerCase();
  return GEO_MARKERS.some((m) => low.includes(m));
}

function isChallenge(status, body) {
  if (status === 403 || status === 503) return true;
  if (!body) return false;
  const head = body.slice(0, 6000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

function headersFor(url, extra = {}) {
  const id = identityFor(url);
  const h = {
    'User-Agent': id?.userAgent || UA_FALLBACK,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
  if (id?.cookie) h.Cookie = id.cookie;
  return h;
}

async function plainFetch(url, { referer, timeout = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const opts = {
      headers: headersFor(url, referer ? { Referer: referer, ...headers } : headers),
      signal: ctrl.signal,
    };
    if (shouldProxy(url)) {
      const d = await getDispatcher();
      if (d) opts.dispatcher = d;
    }
    const { res, url: finalUrl } = await publicFetch(url, opts);
    const body = await res.text();
    return { status: res.status, body, url: finalUrl, via: 'direct' };
  } finally {
    clearTimeout(timer);
  }
}

async function flareFetch(url, { timeout = 60000 } = {}) {
  const endpoint = env('FLARESOLVERR_URL');
  if (!endpoint) return null;

  const payload = {
    cmd: 'request.get',
    url,
    maxTimeout: Math.max(20000, timeout - 5000),
  };
  const proxy = env('PROXY_URL');
  if (proxy && shouldProxy(url)) payload.proxy = { url: proxy };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    await assertPublic(url);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (data.status !== 'ok' || !data.solution) {
      console.warn('[flaresolverr]', data.status, data.message);
      return null;
    }
    const sol = data.solution;
    const cookie = (sol.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
    if (cookie || sol.userAgent) {
      identities.set(new URL(url).origin, {
        cookie,
        userAgent: sol.userAgent || UA_FALLBACK,
        at: Date.now(),
      });
    }
    return { status: sol.status || 200, body: sol.response || '', url: sol.url || url, via: 'flaresolverr' };
  } catch (e) {
    console.warn('[flaresolverr] failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { status, body, url, via }. Escalates to FlareSolverr on a challenge.
export async function siteFetch(url, opts = {}) {
  let best = null;
  try {
    const direct = await plainFetch(url, opts);
    if (!isChallenge(direct.status, direct.body)) return direct;
    best = direct;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[fetch] direct failed:', url, e.message);
  }

  // FlareSolverr runs a browser on our own IP: useful against a challenge,
  // useless against a geo-block, so don't spend a browser round-trip on one.
  if (best && isGeoBlocked(best.body)) return best;

  const solved = await flareFetch(url, opts);
  if (solved) return solved;

  if (best) return best;
  return { status: 0, body: '', url, via: 'failed' };
}

export async function fetchJson(url, opts = {}) {
  const r = await siteFetch(url, opts);
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
}

export { UA_FALLBACK };
