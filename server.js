// Standalone server for self-hosting (e.g. on the Pi next to FlareSolverr).
import http from 'node:http';

// Node's own .env loader — keeps the API key out of the shell history and out
// of the repo (.env is gitignored).
try {
  process.loadEnvFile(new URL('.env', import.meta.url).pathname);
} catch {
  /* no .env — rely on the ambient environment */
}

const { handleRequest, CORS } = await import('./src/handler.js');

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '0.0.0.0';

http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    // Throwing here would be an unhandled rejection, which exits the process.
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, CORS);
      return res.end();
    }
    const query = Object.fromEntries(url.searchParams);
    const { status, headers, body } = await handleRequest(url.pathname, query, {
      host: req.headers.host,
      proto: (req.headers['x-forwarded-proto'] || 'http').split(',')[0],
    });
    res.writeHead(status, headers);
    res.end(body);
  })
  .listen(PORT, HOST, () => {
    console.log(`Kinogo addon on http://${HOST}:${PORT}/manifest.json`);
    console.log(`FlareSolverr: ${process.env.FLARESOLVERR_URL || '(not set)'}`);
    console.log(`Proxy:        ${process.env.PROXY_URL || '(not set)'}`);
  });
