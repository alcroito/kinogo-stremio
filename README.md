# Kinogo — Stremio addon

Russian movies & series from Kinogo, exposed over the Stremio addon protocol.
Search, genre catalogs, automatic movie/series detection, and every stream each
post's players expose.

## What it does

| Resource  | Behaviour |
|-----------|-----------|
| `/`       | Landing page with an install button, the manifest URL and a copy control. Stremio never reads it — it is there for humans. |
| `catalog` | Two catalogs (`Kinogo Фильмы`, `Kinogo Сериалы`), each with search, genre filter and paging (12 per page, mapped onto DLE's own pagination). |
| `meta`    | Title, poster, description, year, genres, cast, director, country, runtime, rating. Series get a full `videos` list. |
| `stream`  | Resolves **all** embeds on a post and returns **every quality** each one exposes, sorted highest-first. |

Ids are `kinogo:<postId>` for titles and `kinogo:<postId>:<season>:<episode>`
for episodes. IMDb ids (`tt…`, `tt…:S:E`) also work — see *IMDb matching*.

### Series auto-detection

A post is treated as a series when any of these hold, checked in order of
reliability:

1. JSON-LD `@type` is `TVSeries` / `TVSeason`, or `numberOfEpisodes > 0`
2. the breadcrumb sits under `/serial/`, `/tv/`, `/multserialy/`, `/doramy/` or `/anime-serialy/`
3. the title carries a `(4 сезон)` / `(1-4 сезон)` suffix
4. the genre line mentions сериал / шоу / передач

Search results carry no category, so the top hits are confirmed against their
detail pages (cached, and needed by `meta` anyway) before being split between
the movie and series catalogs.

Episode lists come from the player's own playlist when it is reachable — that
is the only authoritative season→episode map. When it is not, the addon falls
back to the title's season range and the page's `numberOfEpisodes`.

## How the geo-block is solved

Two opposite constraints, which is why routing is decided per host:

* the **players** (`api.ortified.ws`, `*.stravers.live`) are geo-locked to
  RU/CIS and answer `видео недоступно для вашего региона` from anywhere else;
* the **site** is blocked *inside* Russia by Roskomnadzor — from a Russian exit
  `kinogo.la` times out even on `robots.txt`.

So: site pages go out directly, player embeds go through a Russian exit, and
the resulting stream URLs are handed to Stremio untouched — the CDNs
(`cdnr.interkh.com` and friends) are **not** geo-locked and serve the same 200
from anywhere. No stream proxying is needed, and playback does not depend on
this machine staying up.

The Russian exit is a VPN Gate OpenVPN endpoint run as `kinogo-vpn.service`
with `--route-nopull`, so it never becomes the default route. Selection is by
firewall mark rather than address, because VPN Gate hands out a new tunnel
address on every reconnect:

```
tinyproxy (uid) --iptables MARK 0x64--> ip rule --> table 100 --> tun10
```

`netsetup.sh` installs those rules before OpenVPN starts (none of it survives a
reboot on its own), including a MASQUERADE on `tun10` — the socket picks its
source address before the mark reroutes it, so without that the packets leave
the tunnel wearing the LAN address and the server drops them — and an MSS clamp,
without which large pages stall while small ones succeed.

`PROXY_URL` points at that proxy; `src/fetch.js` applies it only to non-mirror
hosts.

## Requirements and constraints

**The players are geo-locked to RU/CIS.** From anywhere else both balancers
answer `видео недоступно для вашего региона`, and no amount of
Cloudflare-solving changes that. Metadata, search and catalogs work from any
region; *streams* need a Russian exit IP:

* set `PROXY_URL` so the addon resolves embeds through a RU proxy, **and**
* keep in mind that Stremio plays the returned URL from *your* machine, so the
  player CDN sees your own IP — you generally need the RU exit on the client
  side too (VPN), or a restreaming proxy.

When every embed is region-blocked the addon returns a single explanatory
stream entry instead of an empty list, so the failure is visible in the UI.

**FlareSolverr** is only needed for the Cloudflare-gated mirrors
(`kinogo.media`, `kinogo1.biz`). The default mirror `kinogo.la` is currently
served straight from nginx. Requests go out plain first and only escalate to
FlareSolverr when the response looks like a challenge; the resulting cookies
and UA are then reused for ~20 minutes.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FLARESOLVERR_URL` | — | e.g. `http://localhost:8191/v1`. Omit to disable. |
| `PROXY_URL` | — | `http://user:pass@host:port`. Used for direct fetches (needs `undici`) and passed to FlareSolverr. |
| `KINOGO_MIRRORS` | `kinogo.la,kinogo.media,kinogo1.biz` | Tried in order; the first healthy one sticks for 30 min. |
| `CACHE_TTL` | `900` | Seconds for search/browse/detail caching. |
| `PORT` / `HOST` | `7000` / `0.0.0.0` | Standalone server only. |
| `DEBUG_ROUTES` | — | Set to `1` to enable `/debug/*`. Keep it off on public instances: `/debug/embed` fetches any URL. |

## Self-hosting on the Pi (primary deployment)

Runs as two systemd units, both enabled so they survive a reboot:

| Unit | Role |
|---|---|
| `kinogo-vpn.service` | OpenVPN to a Russian exit, split-tunnelled |
| `tinyproxy.service` | local proxy whose egress is that tunnel |
| `kinogo-addon.service` | the Node server on `127.0.0.1:7000` |
| `cloudflared-kinogo.service` | named tunnel → `https://kinogo-strmio.alexaero.dev` |

The tunnel has its own config (`~/.cloudflared/kinogo.yml`) and its own
service, deliberately separate from the `mailhook` and `pi-vpn` tunnels so
restarting this one never disturbs those.

```bash
./run.sh     # start both units, re-arm them for boot, wait for a 200
./kill.sh    # stop both and keep them down across reboots
```

`run.sh` polls the public URL and fails loudly if it does not answer within
~60s. `kill.sh` disables rather than just stopping, so a reboot will not
resurrect what you deliberately took down.

Note on DNS: `cloudflared tunnel route dns` reads the *default* `config.yml`
and will attach the CNAME to whatever tunnel that names. Pass
`--config ~/.cloudflared/kinogo.yml` or the record will point at the wrong
tunnel.

## Running locally

```bash
npm install
FLARESOLVERR_URL=http://localhost:8191/v1 npm start
# http://localhost:7000/manifest.json
```

FlareSolverr, if you want it:

```bash
docker run -d --name flaresolverr -p 8191:8191 \
  --restart unless-stopped ghcr.io/flaresolverr/flaresolverr:latest
```

Add to Stremio: open <http://localhost:7000/> and hit **Установить в Stremio**,
or paste the `manifest.json` URL into Stremio's *Addons → Add addon* box.

## Deploying to Vercel

`vercel.json` rewrites every path to `api/index.js`, so the whole addon is one
serverless function.

```bash
npx vercel            # preview
npx vercel --prod     # production
```

Then set the env vars (Project → Settings → Environment Variables):

```bash
npx vercel env add PROXY_URL production
npx vercel env add FLARESOLVERR_URL production
```

FlareSolverr **cannot run on Vercel** — it needs a long-lived headless Chrome.
Point `FLARESOLVERR_URL` at an instance you host (this Pi behind a tunnel, a
VPS, a Docker host) or leave it unset and rely on the non-Cloudflare mirror.

Manifest URL after deploy: `https://<your-project>.vercel.app/manifest.json`

## IMDb matching

Stremio's own movie pages are IMDb-based, so `tt…` ids are mapped onto Kinogo
posts by title + year. Cinemeta only exposes the English title, which never
matches a Russian catalogue, so the addon first resolves the native title from
Wikidata (`P345` → Russian `rdfs:label`, no API key) and falls back to the
English one. Matches are scored on exact/partial title, year distance and
season, and anything below the threshold is dropped rather than guessed at.

## Diagnostics

The player layer is the part most likely to drift when a balancer changes, so
debug routes are included. They return 404 unless `DEBUG_ROUTES=1` is set:

```bash
curl localhost:7000/debug/health | jq
curl localhost:7000/debug/streams/62113 | jq
curl 'localhost:7000/debug/embed?url=<embed-url>&referer=<page-url>' | jq
```

`/debug/streams/<postId>` reports each embed's host, HTTP status, whether it
was region-blocked, and how many sources were extracted. `/debug/embed` dumps
the raw embed body (first 20 KB) — that is what you need to finish or adjust
the extractor from a Russian IP.

## Layout

```
api/index.js    Vercel function entry
server.js       standalone Node server
src/addon.js    Stremio protocol: manifest, catalog, meta, stream
src/kinogo.js   site adapter: mirrors, search, browse, detail
src/players.js  embed resolution, quality parsing, season/episode trees
src/fetch.js    direct → FlareSolverr escalation, proxy, cookie reuse
src/handler.js  shared CORS/JSON/HTML wrapper
src/landing.js  root install page
src/html.js     entity decoding, tag stripping, JSON-LD
src/cache.js    TTL cache
```
