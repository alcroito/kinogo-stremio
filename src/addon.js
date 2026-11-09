// Stremio addon protocol: manifest, catalog, meta, stream.

import { CATEGORIES, search, browse, detail, splitTitle, pMap } from './kinogo.js';
import { resolveStreams, getPlaylistTree } from './players.js';
import { UA_FALLBACK } from './fetch.js';
import { cached } from './cache.js';

const PAGE_SIZE = 12; // one DLE listing page

export const MANIFEST = {
  id: 'community.kinogo',
  version: '1.0.0',
  name: 'Kinogo',
  description:
    'Русские фильмы и сериалы с Kinogo: поиск, каталоги по жанрам, автоопределение сериалов и все доступные потоки.',
  logo: 'https://kinogo.la/templates/Kinogo/images/logo.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['kinogo', 'tt'],
  catalogs: [
    {
      type: 'movie',
      id: 'kinogo-movie',
      name: 'Kinogo Фильмы',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: CATEGORIES.movie.map((c) => c.label) },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      type: 'series',
      id: 'kinogo-series',
      name: 'Kinogo Сериалы',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: CATEGORIES.series.map((c) => c.label) },
        { name: 'skip', isRequired: false },
      ],
    },
  ],
  behaviorHints: { configurable: false, adult: false },
};

function displayName(item) {
  const s = item.seasons || [];
  if (s.length > 1) return `${item.name} (${s[0]}-${s[s.length - 1]} сезон)`;
  if (item.season) return `${item.name} (${item.season} сезон)`;
  return item.name;
}

const toMeta = (item) => ({
  id: `kinogo:${item.postId}`,
  type: item.type,
  name: displayName(item),
  poster: item.poster,
  posterShape: 'poster',
  background: item.poster,
  description: item.description,
  releaseInfo: item.year ? String(item.year) : undefined,
  genres: item.genres?.length ? item.genres : undefined,
});

// Search hits carry no category, so the listing heuristic can mislabel a show
// as a film. Confirm against the detail page (cached, and needed later anyway).
async function classify(items, limit = 16) {
  const head = items.slice(0, limit);
  const resolved = await pMap(head, async (item) => {
    const d = await detail(item.postId);
    return d ? { ...item, type: d.type, season: d.season ?? item.season, genres: d.genres, year: d.year ?? item.year } : item;
  });
  return resolved.map((r, i) => r || head[i]).concat(items.slice(limit));
}

async function handleCatalog(type, id, extra) {
  if (!MANIFEST.catalogs.some((c) => c.id === id && c.type === type)) return { metas: [] };

  const skip = Number(extra.skip || 0);
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  let items;
  if (extra.search) {
    const raw = await search(extra.search);
    items = (await classify(raw)).filter((i) => i.type === type);
  } else {
    const list = CATEGORIES[type];
    const category = list.find((c) => c.label === extra.genre) || list[0];
    items = (await browse(category.path, page)).map((i) => ({ ...i, type }));
  }

  return { metas: items.map(toMeta) };
}

function videoEntry(d, season, episode, title, ordinal) {
  return {
    id: `kinogo:${d.postId}:${season}:${episode}`,
    title: title || `${episode} серия`,
    season,
    episode,
    released: d.year ? new Date(Date.UTC(d.year, 0, 1 + ordinal)).toISOString() : undefined,
  };
}

// Preference order: the player's real playlist, then a "(1-4 сезон)" range from
// the title, then the page's episode count as a single season.
async function buildVideos(d) {
  const tree = await getPlaylistTree(d).catch(() => null);
  if (tree?.length) {
    const out = [];
    let ordinal = 0;
    for (const s of tree) {
      for (const e of s.episodes) out.push(videoEntry(d, s.season, e.episode, e.title, ordinal++));
    }
    if (out.length) return out;
  }

  const seasons = d.seasons?.length ? d.seasons : [d.season || 1];
  const total = d.episodeCount && d.episodeCount > 0 ? Math.min(d.episodeCount, 1000) : 1;
  const perSeason = Math.max(1, Math.ceil(total / seasons.length));

  const out = [];
  let ordinal = 0;
  for (const season of seasons) {
    for (let e = 1; e <= perSeason; e++) out.push(videoEntry(d, season, e, null, ordinal++));
  }
  return out;
}

async function handleMeta(type, id) {
  const postId = id.split(':')[1];
  if (!postId) return { meta: null };
  const d = await detail(postId);
  if (!d) return { meta: null };

  const meta = {
    id: `kinogo:${d.postId}`,
    type: d.type,
    name: displayName(d),
    poster: d.poster,
    posterShape: 'poster',
    background: d.poster,
    logo: undefined,
    description: d.description,
    releaseInfo: d.year ? String(d.year) : undefined,
    genres: d.genres,
    cast: d.cast,
    director: d.director,
    country: d.country?.join(', '),
    runtime: d.runtime ? `${d.runtime} мин` : undefined,
    imdbRating: d.rating ? String(d.rating) : undefined,
    website: d.url,
  };
  if (d.type === 'series') meta.videos = await buildVideos(d);
  return { meta };
}

const normalize = (s = '') =>
  s.toLowerCase().replace(/[ё]/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();

// Stremio asks by IMDb id from Cinemeta pages; map that back onto a Kinogo post
// by title + year. Russian titles rarely match Cinemeta's English `name`, so we
// try every title variant Cinemeta exposes.
// Cinemeta only carries the English title, which never matches a Russian
// catalogue. Wikidata maps an IMDb id to the native title and needs no key.
async function russianTitle(imdbId) {
  return cached(`wd:${imdbId}`, async () => {
    const query = `SELECT ?l WHERE { ?i wdt:P345 "${imdbId}". ?i rdfs:label ?l FILTER(LANG(?l)="ru") } LIMIT 1`;
    try {
      const res = await fetch(
        `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
        {
          headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'kinogo-stremio/1.0' },
          signal: AbortSignal.timeout(12000),
        }
      );
      const bindings = (await res.json())?.results?.bindings || [];
      return bindings[0]?.l?.value || null;
    } catch {
      return null;
    }
  }, 24 * 60 * 60 * 1000);
}

async function findByImdb(imdbId, type, season) {
  return cached(`imdb:${imdbId}:${type}:${season ?? 'x'}`, async () => {
    let cine = null;
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, {
        signal: AbortSignal.timeout(12000),
      });
      cine = (await res.json())?.meta;
    } catch {
      return null;
    }
    if (!cine) return null;

    const year = Number(String(cine.releaseInfo || cine.year || '').slice(0, 4)) || null;
    const ru = await russianTitle(imdbId);
    const titles = [...new Set([ru, cine.name, cine.originalName].filter(Boolean))];

    for (const title of titles) {
      const hits = await search(title);
      if (!hits.length) continue;
      const wanted = normalize(title);
      const scored = hits
        .map((h) => {
          let score = 0;
          if (normalize(h.name) === wanted) score += 3;
          else if (normalize(h.name).includes(wanted) || wanted.includes(normalize(h.name))) score += 1;
          if (year && h.year === year) score += 2;
          else if (year && h.year && Math.abs(h.year - year) <= 1) score += 1;
          if (season != null && h.season === Number(season)) score += 2;
          return { h, score };
        })
        .filter((s) => s.score >= 3)
        .sort((a, b) => b.score - a.score);
      if (scored.length) return scored[0].h.postId;
    }
    return null;
  });
}

function streamEntry(s, item) {
  const quality = s.quality || 'auto';
  return {
    name: `Kinogo\n${quality}`,
    title: `${displayName(item)}\n${s.host}`,
    url: s.url,
    behaviorHints: {
      // The CDN answers 410 Gone to any request without a browser User-Agent —
      // Referer and Origin are ignored entirely. Playback therefore has to go
      // through Stremio's streaming server, since that is what applies
      // proxyHeaders; playing the URL directly gets 410 on every segment and
      // shows as an endless spinner.
      notWebReady: true,
      bingeGroup: `kinogo-${item.postId}-${quality}`,
      proxyHeaders: {
        request: {
          'User-Agent': UA_FALLBACK,
          Referer: item.url,
        },
      },
    },
  };
}

// Stream resolution is the one resource that needs a Russian exit, and a
// serverless platform cannot host a VPN. Where UPSTREAM_URL is set (i.e. on
// Vercel) that single resource is delegated to an instance that has one; the
// catalogs and metadata are still served locally, and a failed delegation
// falls through to local resolution so the region notice still explains itself.
async function delegateStream(type, id) {
  const upstream = (process.env.UPSTREAM_URL || '').trim().replace(/\/+$/, '');
  if (!upstream) return null;
  try {
    const res = await fetch(`${upstream}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(22000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.streams) && data.streams.length ? data : null;
  } catch (e) {
    console.warn('[upstream] stream delegation failed:', e.message);
    return null;
  }
}

async function handleStream(type, id) {
  const delegated = await delegateStream(type, id);
  if (delegated) return delegated;

  const parts = id.split(':');
  let postId = null;
  let season = null;
  let episode = null;

  if (parts[0] === 'kinogo') {
    postId = parts[1];
    season = parts[2] != null ? Number(parts[2]) : null;
    episode = parts[3] != null ? Number(parts[3]) : null;
  } else if (parts[0].startsWith('tt')) {
    season = parts[1] != null ? Number(parts[1]) : null;
    episode = parts[2] != null ? Number(parts[2]) : null;
    postId = await findByImdb(parts[0], type, season);
  }
  if (!postId) return { streams: [] };

  const d = await detail(postId);
  if (!d) return { streams: [] };
  if (d.type === 'series' && season == null) season = d.season;

  const { streams, diagnostics } = await resolveStreams(d, { season, episode });

  if (!streams.length) {
    const blocked = diagnostics.some((x) => x.geoBlocked);
    return {
      streams: [
        {
          name: 'Kinogo',
          title: blocked
            ? '⚠ Источник недоступен для вашего региона\nНужен RU-прокси (PROXY_URL)'
            : '⚠ Потоки не найдены',
          externalUrl: d.url,
        },
      ],
    };
  }
  return { streams: streams.map((s) => streamEntry(s, d)) };
}

function parseExtra(raw = '') {
  const out = {};
  if (!raw) return out;
  for (const pair of decodeURIComponent(raw).split('&')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

// Returns { status, json } for any addon path.
export async function route(pathname, query = {}, ctx = {}) {
  const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');

  // Root is a human landing page; Stremio itself only ever reads the manifest.
  // Imported lazily because landing.js reads MANIFEST from this module.
  if (clean === '') {
    const { landingPage } = await import('./landing.js');
    return {
      status: 200,
      html: landingPage({ host: ctx.host || 'localhost', proto: ctx.proto || 'http' }),
    };
  }

  if (clean === 'manifest.json') return { status: 200, json: MANIFEST };

  const parts = clean.split('/');

  if (parts[0] === 'catalog' && parts.length >= 3) {
    const type = parts[1];
    const id = parts[2].replace(/\.json$/, '');
    const extra = parts.length >= 4 ? parseExtra(parts[3].replace(/\.json$/, '')) : { ...query };
    return { status: 200, json: await handleCatalog(type, id, extra) };
  }

  if (parts[0] === 'meta' && parts.length === 3) {
    return { status: 200, json: await handleMeta(parts[1], parts[2].replace(/\.json$/, '')) };
  }

  if (parts[0] === 'stream' && parts.length === 3) {
    return { status: 200, json: await handleStream(parts[1], parts[2].replace(/\.json$/, '')) };
  }

  // /debug/embed fetches any URL it is given, so a public instance must not serve these.
  if (parts[0] === 'debug' && process.env.DEBUG_ROUTES !== '1') {
    return { status: 404, json: { error: 'not found', seen: clean } };
  }

  // Diagnostics — the player layer is the part most likely to drift.
  if (parts[0] === 'debug' && parts[1] === 'streams' && parts[2]) {
    const d = await detail(parts[2].replace(/\.json$/, ''));
    if (!d) return { status: 404, json: { error: 'not found' } };
    const out = await resolveStreams(d, {
      season: query.season ? Number(query.season) : d.season,
      episode: query.episode ? Number(query.episode) : null,
    });
    return { status: 200, json: { item: { ...d, embeds: d.embeds }, ...out } };
  }

  if (parts[0] === 'debug' && parts[1] === 'health') {
    const { base } = await import('./kinogo.js');
    const flare = process.env.FLARESOLVERR_URL || null;
    let flareOk = false;
    if (flare) {
      try {
        const r = await fetch(flare, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd: 'sessions.list' }),
          signal: AbortSignal.timeout(8000),
        });
        flareOk = r.ok;
      } catch {
        flareOk = false;
      }
    }
    return {
      status: 200,
      json: {
        mirror: await base(),
        flaresolverr: { url: flare, reachable: flareOk },
        proxy: process.env.PROXY_URL ? 'set' : null,
        streamsLikelyWork: Boolean(process.env.PROXY_URL),
      },
    };
  }

  if (parts[0] === 'debug' && parts[1] === 'embed' && query.url) {
    const { siteFetch } = await import('./fetch.js');
    const r = await siteFetch(query.url, { referer: query.referer, timeout: 25000 });
    return {
      status: 200,
      json: { status: r.status, via: r.via, length: r.body.length, body: r.body.slice(0, 20000) },
    };
  }

  return { status: 404, json: { error: 'not found', seen: clean } };
}
