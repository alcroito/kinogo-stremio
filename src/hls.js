// Serves HLS playlists with a Content-Length. The CDN sends them chunked, and
// players running FFmpeg with reconnect_streamed (Nuvio) treat the end of a
// chunked playlist as a dropped connection and re-request it forever. Video
// segments already carry a Content-Length and keep going straight to the CDN.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicFetch, UA_FALLBACK } from './fetch.js';

// Without HLS_SECRET a restart only invalidates playlists no player has opened yet.
const key = process.env.HLS_SECRET?.trim() || randomBytes(32);

const sign = (encoded) => createHmac('sha256', key).update(encoded).digest('base64url');

export function isPlaylistUrl(url) {
  try {
    return new URL(url).pathname.endsWith('.m3u8');
  } catch {
    return false;
  }
}

export function proxiedPlaylistUrl(url, { proto, host }) {
  const encoded = Buffer.from(url).toString('base64url');
  return `${proto}://${host}/hls/${encoded}.${sign(encoded)}/index.m3u8`;
}

function verifiedUrl(token) {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(encoded));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return Buffer.from(encoded, 'base64url').toString();
}

function rewritePlaylist(text, baseUrl, ctx) {
  const target = (ref) => {
    const absolute = new URL(ref, baseUrl).href;
    return isPlaylistUrl(absolute) ? proxiedPlaylistUrl(absolute, ctx) : absolute;
  };
  return text
    .split('\n')
    .map((raw) => {
      const line = raw.trim();
      if (!line) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${target(ref)}"`);
      return target(line);
    })
    .join('\n');
}

export async function servePlaylist(token, ctx) {
  const url = verifiedUrl(token);
  if (!url) return { status: 404, json: { error: 'not found' } };

  const { res, url: finalUrl } = await publicFetch(url, {
    headers: { 'User-Agent': UA_FALLBACK },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (res.status !== 200 || !text.startsWith('#EXTM3U')) {
    return { status: 502, json: { error: 'upstream did not return a playlist' } };
  }
  return { status: 200, playlist: rewritePlaylist(text, finalUrl, ctx) };
}
