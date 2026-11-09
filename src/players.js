// Embed resolvers. Kinogo never hosts video itself — each post embeds one or
// more third-party balancers, so "all streams" means: resolve every embed, and
// return every quality each one exposes.

import { siteFetch, isGeoBlocked, UA_FALLBACK } from './fetch.js';
import { cached } from './cache.js';
import { decodeEntities } from './html.js';

const QUALITY_RE = /\[(\d{3,4}p?(?:[^\]]*)?)\]/;

function qualityRank(label = '') {
  const n = Number((label.match(/(\d{3,4})/) || [])[1] || 0);
  return n;
}

// Playerjs encodes multi-quality sources as "[1080p]url,[720p]url" and
// sometimes uses " or " between mirrors of the same quality.
export function parseFileString(file) {
  const out = [];
  if (typeof file !== 'string' || !file) return out;
  for (const chunk of file.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const q = part.match(QUALITY_RE);
    const label = q ? q[1] : '';
    const urls = part
      .replace(QUALITY_RE, '')
      .split(/\s+or\s+/i)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u) || u.startsWith('//'));
    for (const u of urls) out.push({ url: u.startsWith('//') ? `https:${u}` : u, quality: label });
  }
  return out;
}

// Some balancers ship the file value base64'd behind a marker prefix.
function maybeDecode(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^https?:\/\/|^\[|^\/\//i.test(trimmed)) return trimmed;
  const cleaned = trimmed.replace(/^#\d+#?/, '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (cleaned.length < 24 || cleaned.length % 4 !== 0) return trimmed;
  try {
    const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
    return /https?:\/\//i.test(decoded) ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}

// Walks a Playerjs season/episode playlist. Shape in the wild:
// [{ title:"1 сезон", folder:[{ title:"1 серия", file:"[720p]..." }] }]
export function pickFromPlaylist(playlist, season, episode) {
  const found = [];
  const wantSeason = season != null ? Number(season) : null;
  const wantEpisode = episode != null ? Number(episode) : null;

  const numOf = (s = '') => Number((String(s).match(/(\d+)/) || [])[1]);

  const walk = (nodes, ctxSeason) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const title = node.title || node.name || '';
      const isSeasonNode = /сезон|season/i.test(title);
      const seasonNo = isSeasonNode ? numOf(title) : ctxSeason;

      if (Array.isArray(node.folder)) {
        walk(node.folder, seasonNo);
        continue;
      }
      const episodeNo = numOf(title);
      const seasonOk = wantSeason == null || seasonNo == null || seasonNo === wantSeason;
      const episodeOk = wantEpisode == null || episodeNo === wantEpisode;
      if (seasonOk && episodeOk && node.file) {
        found.push(...parseFileString(maybeDecode(node.file)).map((s) => ({ ...s, label: title })));
      }
    }
  };
  walk(playlist, wantSeason);
  return found;
}

// Collaps-style players (api.ortified.ws and friends) do not use a Playerjs
// `file` string. They inline a JS options object whose playlist looks like:
//
//   playlist: { current: { season: 4, episode: "1" },
//               seasons: [ { season: 3, episodes: [ { episode: "1",
//                            hls: "…master.m3u8", dash: "…mpd" } ] } ] }
//
// Without parsing that, the generic URL scrape returns every episode in the
// series for a single-episode request.
function sliceBalanced(text, start, open = '[', close = ']') {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function extractSeasonTree(html) {
  const m = /seasons\s*:\s*\[/.exec(html);
  if (!m) return null;
  const raw = sliceBalanced(html, html.indexOf('[', m.index));
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  return parsed
    .map((s) => ({
      season: Number(s.season),
      episodes: (s.episodes || [])
        .map((e) => ({
          episode: Number(e.episode),
          hls: typeof e.hls === 'string' ? e.hls : null,
          dash: typeof e.dash === 'string' ? e.dash : null,
        }))
        .filter((e) => Number.isFinite(e.episode))
        .sort((a, b) => a.episode - b.episode),
    }))
    .filter((s) => Number.isFinite(s.season))
    .sort((a, b) => a.season - b.season);
}

// Which season/episode the embed itself selected, used when the caller did not
// pin one down.
function currentSelection(html) {
  const m = /current\s*:\s*\{([\s\S]{0,160}?)\}/.exec(html);
  if (!m) return {};
  const season = /season\s*:\s*"?(\d+)"?/.exec(m[1]);
  const episode = /episode\s*:\s*"?(\d+)"?/.exec(m[1]);
  return {
    season: season ? Number(season[1]) : null,
    episode: episode ? Number(episode[1]) : null,
  };
}

export function pickFromSeasonTree(html, season, episode) {
  const tree = extractSeasonTree(html);
  if (!tree?.length) return null;

  const cur = currentSelection(html);
  const wantSeason = season ?? cur.season;
  const wantEpisode = episode ?? cur.episode;

  const s =
    tree.find((x) => x.season === Number(wantSeason)) ?? (wantSeason == null ? tree[0] : null);
  if (!s) return [];

  const e =
    s.episodes.find((x) => x.episode === Number(wantEpisode)) ??
    (wantEpisode == null ? s.episodes[0] : null);
  if (!e) return [];

  const out = [];
  if (e.hls) out.push({ url: e.hls, quality: '' });
  if (e.dash) out.push({ url: e.dash, quality: 'dash' });
  return out;
}

function extractPlaylist(html) {
  // `file:` may hold a JSON array (series) or a quality string (movie).
  const candidates = [];
  const re = /["']?file["']?\s*:\s*(\[[\s\S]*?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  let m;
  while ((m = re.exec(html))) candidates.push(m[1]);
  return candidates;
}

function collectDirect(html) {
  const out = [];
  // The extension must end the path: these CDNs serve HLS from paths like
  // ".../NAME.mp4/master.m3u8", where a lazy match on ".mp4" would truncate the
  // URL to a directory and yield an unplayable link.
  const re = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?![\w/]|%[0-9A-Fa-f]{2})(?:\?[^\s"'<>\\]*)?/gi;

  // Players often carry the real URL percent-encoded inside a redirector's
  // query string, where the pattern above would stop at the first "%2F" and
  // yield a directory rather than a playlist. Scanning a decoded copy as well
  // recovers the inner URL intact; duplicates collapse below.
  const haystacks = [html];
  try {
    const decoded = decodeURIComponent(html.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    if (decoded !== html) haystacks.push(decoded);
  } catch {
    /* malformed escapes — the raw pass still applies */
  }

  for (const hay of haystacks) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(hay))) {
      const url = m[0].replace(/\\\//g, '/');
      if (!out.some((s) => s.url === url)) out.push({ url, quality: '' });
    }
  }
  return out;
}

function nestedIframe(html, baseUrl) {
  const m = html.match(/<iframe[^>]*?\ssrc=["']([^"']+)["']/i);
  if (!m) return null;
  try {
    return new URL(decodeEntities(m[1]), baseUrl).href;
  } catch {
    return null;
  }
}

// Resolve one embed into a flat list of playable sources.
async function resolveOne(embedUrl, { referer, season, episode, depth = 0 }) {
  let url = embedUrl;
  if (season != null && !/[?&]season=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + `season=${season}`;
  }
  if (episode != null && !/[?&]episode=/.test(url)) {
    url += `&episode=${episode}`;
  }

  const r = await siteFetch(url, { referer, timeout: 25000 });
  const body = r.body || '';

  if (isGeoBlocked(body)) {
    return { host: new URL(url).hostname, geoBlocked: true, sources: [], status: r.status };
  }

  const sources = [];

  // Season/episode aware extraction first: the generic scrape below cannot
  // tell one episode's URLs from another's.
  const picked = pickFromSeasonTree(body, season, episode);
  if (picked?.length) {
    const host0 = new URL(url).hostname;
    return { host: host0, geoBlocked: false, sources: picked, status: r.status };
  }

  for (const raw of extractPlaylist(body)) {
    let value = raw;
    if (/^["']/.test(raw)) {
      try {
        value = JSON.parse(raw.replace(/^'/, '"').replace(/'$/, '"'));
      } catch {
        value = raw.slice(1, -1);
      }
      sources.push(...parseFileString(maybeDecode(value)));
    } else {
      try {
        sources.push(...pickFromPlaylist(JSON.parse(raw), season, episode));
      } catch {
        /* not valid JSON — fall through to direct scraping */
      }
    }
  }

  if (!sources.length) sources.push(...collectDirect(body));

  // Balancers frequently bounce through one more iframe before the real player.
  if (!sources.length && depth < 2) {
    const next = nestedIframe(body, url);
    if (next && next !== url) {
      return resolveOne(next, { referer: url, season, episode, depth: depth + 1 });
    }
  }

  const host = new URL(url).hostname;
  const seen = new Set();
  const unique = sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
  return { host, geoBlocked: false, sources: unique, status: r.status };
}

// Sends the same headers as the stream's proxyHeaders. Unreachable counts as
// usable: a slow probe from this host says nothing about the viewer's playback.
async function isForbidden(url, referer) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_FALLBACK, Referer: referer },
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    return res.status === 403;
  } catch {
    return false;
  }
}

// Resolve every embed on a post, in parallel, into Stremio-ready stream objects.
export async function resolveStreams(item, { season = null, episode = null } = {}) {
  const key = `streams:${item.postId}:${season ?? 'x'}:${episode ?? 'x'}`;
  return cached(
    key,
    async () => {
      const results = await Promise.all(
        (item.embeds || []).map((e) =>
          resolveOne(e, { referer: item.url, season, episode }).catch((err) => ({
            host: (() => { try { return new URL(e).hostname; } catch { return e; } })(),
            error: err.message,
            sources: [],
          }))
        )
      );

      const streams = [];
      for (const res of results) {
        for (const src of res.sources) {
          streams.push({
            host: res.host,
            url: src.url,
            quality: src.quality || src.label || '',
            rank: qualityRank(src.quality || src.label || ''),
          });
        }
      }
      const forbidden = await Promise.all(streams.map((s) => isForbidden(s.url, item.url)));
      const usable = streams.filter((_, i) => !forbidden[i]).sort((a, b) => b.rank - a.rank);
      return { streams: usable, diagnostics: results.map((r) => ({ host: r.host, geoBlocked: !!r.geoBlocked, found: r.sources.length, status: r.status, error: r.error })) };
    },
    5 * 60 * 1000
  );
}

export { resolveOne, isGeoBlocked };

const numOf = (s = '') => Number((String(s).match(/(\d+)/) || [])[1]);

// Collapse a Playerjs playlist into [{ season, episodes: [{ episode, title }] }].
export function buildTree(playlist, fallbackSeason = 1) {
  const seasons = new Map();
  const add = (seasonNo, episodeNo, title) => {
    if (!episodeNo) return;
    const key = seasonNo || fallbackSeason;
    if (!seasons.has(key)) seasons.set(key, new Map());
    const eps = seasons.get(key);
    if (!eps.has(episodeNo)) eps.set(episodeNo, title);
  };

  const walk = (nodes, ctxSeason) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const title = node.title || node.name || '';
      const isSeasonNode = /сезон|season/i.test(title);
      const seasonNo = isSeasonNode ? numOf(title) : ctxSeason;
      if (Array.isArray(node.folder)) walk(node.folder, seasonNo);
      else add(seasonNo, numOf(title), title);
    }
  };
  walk(playlist, null);

  return [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => ({
      season,
      episodes: [...eps.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([episode, title]) => ({ episode, title })),
    }));
}

// The player's own playlist is the only authoritative season/episode map, so
// try it before falling back to the page's numberOfEpisodes.
export async function getPlaylistTree(item) {
  return cached(
    `tree:${item.postId}`,
    async () => {
      for (const embed of item.embeds || []) {
        try {
          const r = await siteFetch(embed, { referer: item.url, timeout: 25000 });
          if (!r.body || isGeoBlocked(r.body)) continue;

          // Preferred: the Collaps season/episode map, which is exact.
          const collaps = extractSeasonTree(r.body);
          if (collaps?.length) {
            const tree = collaps
              .filter((s) => s.episodes.length)
              .map((s) => ({
                season: s.season,
                episodes: s.episodes.map((e) => ({ episode: e.episode, title: `${e.episode} серия` })),
              }));
            if (tree.length) return tree;
          }

          for (const raw of extractPlaylist(r.body)) {
            if (!raw.trim().startsWith('[')) continue;
            try {
              const tree = buildTree(JSON.parse(raw), item.season || 1);
              if (tree.length && tree.some((s) => s.episodes.length)) return tree;
            } catch {
              /* not the playlist we're after */
            }
          }
        } catch {
          /* try the next embed */
        }
      }
      return null;
    },
    10 * 60 * 1000
  );
}
