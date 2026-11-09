// Root page. Stremio only ever reads /manifest.json, so / is free to be the
// thing a human lands on: what this is, and a one-click install.

import { MANIFEST } from './addon.js';

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function landingPage({ host, proto }) {
  const manifestUrl = `${proto}://${host}/manifest.json`;
  const deepLink = `stremio://${host}/manifest.json`;
  const webLink = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;

  const catalogs = MANIFEST.catalogs
    .map((c) => `<li>${esc(c.name)} — поиск, жанры, постраничная загрузка</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(MANIFEST.name)} — Stremio addon</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem 1rem;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #2a2550 0%, #14131f 55%, #0d0c14 100%);
    color: #e9e7f5;
  }
  .card {
    width: 100%; max-width: 46rem; background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.10); border-radius: 18px; padding: 2.25rem;
    backdrop-filter: blur(8px); box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  h1 { margin: 0 0 .25rem; font-size: 1.9rem; letter-spacing: -.02em; }
  .version { color: #9a94c4; font-size: .85rem; }
  p.desc { color: #c5c0e0; margin: 1rem 0 1.75rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.75rem; }
  a.btn, button.btn {
    appearance: none; cursor: pointer; font: inherit; font-weight: 600; font-size: .95rem;
    padding: .7rem 1.4rem; border-radius: 10px; border: 1px solid transparent; text-decoration: none;
    transition: transform .12s ease, filter .12s ease;
  }
  a.btn:active, button.btn:active { transform: translateY(1px); }
  .primary { background: linear-gradient(180deg,#7b5cff,#6842f5); color: #fff; }
  .primary:hover { filter: brightness(1.12); }
  .ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); color: #e9e7f5; }
  .ghost:hover { background: rgba(255,255,255,.11); }
  code.url {
    display: block; padding: .8rem 1rem; border-radius: 10px; background: #0a0912;
    border: 1px solid rgba(255,255,255,.10); color: #a5f3c4; font-size: .88rem;
    word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .09em; color: #8d86bb;
       margin: 1.75rem 0 .6rem; font-weight: 700; }
  ul { margin: 0; padding-left: 1.2rem; color: #c5c0e0; }
  li { margin: .3rem 0; }
  .note { margin-top: 1.75rem; padding: .9rem 1.1rem; border-radius: 10px; font-size: .88rem;
          background: rgba(255,184,92,.09); border: 1px solid rgba(255,184,92,.25); color: #f3d8a8; }
  footer { margin-top: 1.5rem; font-size: .8rem; color: #7d76a8; }
  footer a { color: #9f97d8; }
</style>
</head>
<body>
  <main class="card">
    <h1>${esc(MANIFEST.name)}</h1>
    <div class="version">v${esc(MANIFEST.version)} · ${MANIFEST.types.map(esc).join(' · ')}</div>
    <p class="desc">${esc(MANIFEST.description)}</p>

    <div class="actions">
      <a class="btn primary" href="${esc(deepLink)}">Установить в Stremio</a>
      <a class="btn ghost" href="${esc(webLink)}" target="_blank" rel="noopener">Stremio Web</a>
      <button class="btn ghost" id="copy">Скопировать URL</button>
    </div>

    <code class="url" id="manifest">${esc(manifestUrl)}</code>

    <h2>Каталоги</h2>
    <ul>${catalogs}</ul>

    <h2>Возможности</h2>
    <ul>
      <li>Автоопределение фильмов и сериалов</li>
      <li>Сезоны и серии из плейлиста плеера</li>
      <li>Все доступные качества из всех плееров</li>
      <li>Поддержка IMDb-идентификаторов (tt…)</li>
    </ul>

    <div class="note">
      Потоки доступны только с российского IP. Без <code>PROXY_URL</code> поиск и
      метаданные работают, а плееры возвращают «недоступно для вашего региона».
    </div>

    <footer>
      Манифест: <a href="/manifest.json">/manifest.json</a>
    </footer>
  </main>
<script>
  document.getElementById('copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(document.getElementById('manifest').textContent);
      btn.textContent = 'Скопировано';
    } catch {
      btn.textContent = 'Не удалось';
    }
    setTimeout(() => { btn.textContent = 'Скопировать URL'; }, 1600);
  });
</script>
</body>
</html>`;
}
