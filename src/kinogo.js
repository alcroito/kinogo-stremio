// Kinogo site adapter: mirror selection, search, category browse, detail pages.

import { siteFetch } from './fetch.js';
import { cached, cacheGet, cacheSet } from './cache.js';
import { stripTags, decodeEntities, meta, jsonLd, absolute } from './html.js';

const DEFAULT_MIRRORS = ['https://kinogo.la', 'https://kinogo.media', 'https://kinogo1.biz'];

export const CATEGORIES = {
  movie: [
    { label: 'Все фильмы', path: '/film/' },
    { label: 'Русские фильмы', path: '/film/russkie-filmy/' },
    { label: 'Зарубежные фильмы', path: '/film/zarubezhnye-filmy/' },
    { label: 'Боевики', path: '/film/boeviki/' },
    { label: 'Комедии', path: '/film/komedii/' },
    { label: 'Драмы', path: '/film/dramy/' },
    { label: 'Детективы', path: '/film/detektivy/' },
    { label: 'Фантастика', path: '/film/fantastika/' },
    { label: 'Триллеры', path: '/film/trillery/' },
    { label: 'Ужасы', path: '/film/uzhasy/' },
    { label: 'Мелодрамы', path: '/film/melodramy/' },
    { label: 'Военные', path: '/film/voennye/' },
    { label: 'Мультфильмы', path: '/mult/' },
  ],
  series: [
    { label: 'Сериалы', path: '/serial/' },
    { label: 'Детективы', path: '/serial/detektiv/' },
    { label: 'Драмы', path: '/serial/drama/' },
    { label: 'Комедии', path: '/serial/komediya/' },
    { label: 'Боевики', path: '/serial/boevik/' },
    { label: 'Фантастика', path: '/serial/fantastik/' },
    { label: 'Турецкие сериалы', path: '/serial/tureckie-serialy/' },
    { label: 'ТВ передачи и Шоу', path: '/tv/' },
    { label: 'Мультсериалы', path: '/multserialy/' },
    { label: 'Дорамы', path: '/doramy/' },
    { label: 'Аниме', path: '/anime/anime-serialy/' },
  ],
};

const SERIES_PATH_RE = /\/(serial|tv|multserialy|doramy|anime-serialy)\//i;
const SEASON_IN_TITLE_RE = /\((\d+)\s*сезон/i;

function mirrors() {
  const raw = (process.env.KINOGO_MIRRORS || '').trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_MIRRORS;
}

// Sticky per-instance mirror: re-probed only when the current one starts failing.
export async function base() {
  const hit = cacheGet('base');
  if (hit) return hit;
  for (const m of mirrors()) {
    try {
      const r = await siteFetch(`${m}/`, { timeout: 15000 });
      if (r.status === 200 && /class="movie"/.test(r.body)) {
        return cacheSet('base', m, 30 * 60 * 1000);
      }
    } catch {
      /* try next mirror */
    }
  }
  return cacheSet('base', mirrors()[0], 60 * 1000);
}

export function postIdFromUrl(url = '') {
  const m = url.match(/\/(\d+)-[^/]*\.html/);
  return m ? m[1] : null;
}

function fullPoster(url) {
  // List pages serve /thumbs/ crops; the detail-page original is the same path
  // without that segment and looks far better on a Stremio board.
  return url ? url.replace('/thumbs/', '/') : url;
}

export function splitTitle(raw = '') {
  const title = decodeEntities(raw).trim();
  const year = title.match(/\((\d{4})(?:[^)]*)\)/);
  const season = title.match(SEASON_IN_TITLE_RE);
  const name = title
    .replace(/\s*\((?:\d{4}[^)]*|\d+\s*[-–—]?\s*\d*\s*сезон[^)]*)\)\s*/gi, ' ')
    .replace(/\s*\(\s*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "(1-4 сезон)" style posts bundle several seasons behind one page.
  const range = title.match(/\((\d+)\s*[-–—]\s*(\d+)\s*сезон/i);
  const seasons = range
    ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
    : season
      ? [Number(season[1])]
      : [];

  return {
    name: name || title,
    year: year ? Number(year[1]) : null,
    season: season ? Number(season[1]) : range ? Number(range[1]) : null,
    seasons,
  };
}

// Parses the repeated `<div class="movie" id="...">` blocks used by every
// listing page (home, category, search).
export function parseList(html, baseUrl) {
  const out = [];
  const blocks = html.split(/<div class="movie" id="/).slice(1);
  for (const block of blocks) {
    const id = (block.match(/^(\d+)/) || [])[1];
    const link = block.match(/<h2 class="zagolovki"><a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!id || !link) continue;
    const url = absolute(link[1], baseUrl);
    const { name, year, season, seasons } = splitTitle(stripTags(link[2]));
    const img = block.match(/class="movie__info-img"[\s\S]{0,400}?<img[^>]*?data-src="([^"]+)"/);
    const desc = block.match(/class="movie__info-desc"[^>]*>([\s\S]*?)<\/div>/);
    out.push({
      postId: id,
      url,
      name,
      year,
      season,
      seasons,
      poster: img ? fullPoster(absolute(img[1], baseUrl)) : null,
      description: desc ? stripTags(desc[1]).slice(0, 400) : '',
      // Provisional; detail() is authoritative.
      type: season || SERIES_PATH_RE.test(url || '') ? 'series' : 'movie',
    });
  }
  return out;
}

export async function search(query) {
  const key = `search:${query.toLowerCase()}`;
  return cached(key, async () => {
    const root = await base();
    const url = `${root}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
    const r = await siteFetch(url, { referer: `${root}/`, timeout: 25000 });
    return parseList(r.body, root);
  });
}

export async function browse(path, page = 1) {
  const key = `browse:${path}:${page}`;
  return cached(key, async () => {
    const root = await base();
    const url = page > 1 ? `${root}${path}page/${page}/` : `${root}${path}`;
    const r = await siteFetch(url, { referer: `${root}/`, timeout: 25000 });
    return parseList(r.body, root);
  });
}

function infoItems(html) {
  const out = {};
  const re = /<div class="movie__info-item[^"]*">([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[1]);
    const idx = text.indexOf(':');
    if (idx > 0) out[text.slice(0, idx).trim().toLowerCase()] = text.slice(idx + 1).trim();
  }
  return out;
}

function parseRuntime(s = '') {
  const h = Number((s.match(/(\d+)\s*ч/) || [])[1] || 0);
  const min = Number((s.match(/(\d+)\s*мин/) || [])[1] || 0);
  const total = h * 60 + min;
  return total || null;
}

function embedsFrom(html, pageUrl) {
  const out = [];
  const re = /<iframe[^>]*?data-src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absolute(decodeEntities(m[1]), pageUrl);
    // Posts also embed a trailer player. It resolves to a perfectly valid
    // stream, which is precisely the problem: offered next to the real ones it
    // is indistinguishable until you press play.
    if (url && !/\/embed\/trailer\//i.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

// Full detail page: metadata plus the player embeds we later resolve to streams.
export async function detail(postId) {
  return cached(`detail:${postId}`, async () => {
    const root = await base();
    // DLE resolves a bare numeric id to the canonical slug via a redirect.
    const r = await siteFetch(`${root}/${postId}-.html`, { referer: `${root}/`, timeout: 25000 });
    if (!r.body || !/class="movie__info|<iframe/i.test(r.body)) return null;

    const pageUrl = r.url || `${root}/${postId}-.html`;
    const ld = jsonLd(r.body);
    const entity = ld.find((n) => ['Movie', 'TVSeries', 'TVSeason', 'CreativeWork'].includes(n['@type'])) || {};
    const crumbs = ld.find((n) => n['@type'] === 'BreadcrumbList');
    const crumbUrl = crumbs?.itemListElement?.[1]?.item?.['@id'] || '';
    const info = infoItems(r.body);

    // JSON-LD drops the "(1-4 сезон)" suffix that the breadcrumb and <h1> keep,
    // and that suffix is what tells us how many seasons this post covers.
    const crumbTitle = crumbs?.itemListElement?.slice(-1)[0]?.item?.name;
    const h1 = (r.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    const ogTitle = (meta(r.body, 'og:title') || '').replace(/\s*смотреть онлайн.*$/i, '').trim();
    const rawTitle = crumbTitle || stripTags(h1 || '') || ogTitle || entity.name || '';
    const { name, year, season, seasons } = splitTitle(rawTitle);

    const isSeries =
      entity['@type'] === 'TVSeries' ||
      entity['@type'] === 'TVSeason' ||
      Number(entity.numberOfEpisodes) > 0 ||
      season != null ||
      SERIES_PATH_RE.test(crumbUrl) ||
      /сериал|шоу|передач/i.test(info['жанр'] || '');

    const genres = (Array.isArray(entity.genre) ? entity.genre : (info['жанр'] || '').split(/[,|]/))
      .map((g) => String(g).trim())
      .filter(Boolean);

    return {
      postId: String(postId),
      url: pageUrl,
      type: isSeries ? 'series' : 'movie',
      name,
      title: rawTitle,
      season,
      seasons,
      year: year || Number(info['год выпуска']) || null,
      description: stripTags(entity.description || meta(r.body, 'og:description') || ''),
      poster: fullPoster(absolute(entity.image || meta(r.body, 'og:image'), pageUrl)),
      genres,
      country: (info['страна'] || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean),
      director: (info['режиссер'] || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean),
      cast: (info['в ролях'] || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
      quality: info['качество'] || null,
      runtime: parseRuntime(info['продолжительность'] || ''),
      rating: entity.aggregateRating?.ratingValue ?? null,
      episodeCount: Number(entity.numberOfEpisodes) || null,
      embeds: embedsFrom(r.body, pageUrl),
    };
  });
}

// Bounded-concurrency map so a search doesn't open 12 sockets at once.
export async function pMap(items, fn, concurrency = 6) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch {
          out[idx] = null;
        }
      }
    })
  );
  return out;
}
