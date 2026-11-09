// Shared request handling: CORS + JSON, used by both the Vercel function and
// the standalone server so behaviour can't drift between them.

import { route } from './addon.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function handleRequest(pathname, query, ctx = {}) {
  try {
    const { status, json, html, playlist } = await route(pathname, query, ctx);
    if (playlist !== undefined) {
      return {
        status,
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(playlist),
          'Cache-Control': 'no-store',
        },
        body: playlist,
      };
    }
    const cacheable = status === 200 && !pathname.includes('/debug/');
    return {
      status,
      headers: {
        ...CORS,
        'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': cacheable ? 'public, max-age=300, stale-while-revalidate=600' : 'no-store',
      },
      body: html ?? JSON.stringify(json),
    };
  } catch (err) {
    console.error('[addon]', pathname, err);
    return {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: err.message }),
    };
  }
}

export { CORS };
