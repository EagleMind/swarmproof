# Using swarm-scout

How to put this in front of your own content and get useful answers out of it.

`ARCHITECTURE.md` explains why the internals are shaped the way they are, and
`README.md` covers what was measured. This file is the practical one: what to
call, what comes back, what it means, and where it will mislead you if you read
it too casually.

The HTTP routes below are also published as an OpenAPI 3.1 reference:
**[swarm-scout-docs.hassen-ben-mbarek.workers.dev](https://swarm-scout-docs.hassen-ben-mbarek.workers.dev)**
— browsable, with the raw spec at `/openapi.json` if you would rather generate
a client than read prose.

---

## What it answers

Given a set of **candidates you already have** — magnets, infohashes, alternate
releases of one title — it tells you which swarms are alive and how alive, then
streams bytes from the one it picked so you can prove the answer was right.

It does **not** tell you what exists, or find a title by name. That is a
catalogue, and this is deliberately not one. You bring the infohashes; this
layer judges them.

---

## Install

```bash
npm install
```

Node 18+. No build step, no database to provision, no keys required — every
external dependency is optional and the thing works offline-ish (real network,
no accounts) out of the box.

```bash
npm start
```

Starts the engine on `http://127.0.0.1:8080`. `curl localhost:8080/healthz`
should answer immediately; if it does, your install is good.

```bash
npm run demo
```

Ranks three Blender open movies, streams the winner, and prints a URL you can
point `mpv`, VLC, or a `<video>` tag at — an end-to-end check that the network
path works from your machine.

---

## The verdict: what you actually get

Every answer carries one of four verdicts. This is the core of the product, so
it is worth reading once properly.

| verdict | meaning |
|---|---|
| `verified` | a peer served the real torrent — SHA1(info) matched the infohash |
| `reachable` | peer addresses found, none served metadata |
| `claimed` | trackers report a swarm, no address was obtained |
| `none` | no signal anywhere |

Results are sorted by verdict tier first, then by score inside the tier. So
nothing unproven can outrank something proven, and nothing loses its score.

Why four and not two: a tracker scrape returns counts with no addresses and
nothing checks them. Measured here, an infohash that has never existed reported
45 seeders and 459 leechers — hundreds of clients announcing to a placeholder —
and out-scored a torrent that streams. Only `verified` cannot be faked, because
`ut_metadata` checks SHA1(info) against the infohash before returning.

And the other direction matters just as much: **`claimed` is not `none`.** Some
healthy swarms have no reachable DHT presence at all — Ubuntu's returned zero
peers at every window up to 15 seconds while Sintel saturated at 202 by 900ms —
and a scrape yields no addresses to verify with. Absence of proof is not proof
of absence. Render `claimed` as its own state; collapsing it into "dead" hides
working torrents.

---

## The HTTP API

Start the engine and talk to it over HTTP. No imports, no orchestration, works
from any language.

```bash
npm start
```

```bash
curl -X POST http://127.0.0.1:8080/v1/assess \
  -H 'content-type: application/json' \
  -d '{"input":"magnet:?xt=urn:btih:08ada5a7a6...&dn=Sintel"}'
```

`input` is newline-separated magnets and/or bare infohashes. A real response:

```json
{ "elapsedMs": 18320, "candidates": [
  { "label": "Sintel", "infoHash": "08ada5a7…",
    "verdict": "verified", "verified": true, "score": 2029,
    "claimed":  { "seeders": 115, "leechers": 51 },
    "observed": { "peers": 121, "dhtCount": 202 },
    "meta": { "name": "Sintel", "size": 129302391, "files": 11, "paths": [...] },
    "verifyMs": 17517, "verifyTimedOut": false },

  { "label": "00000000", "verdict": "claimed", "score": 929,
    "claimed": { "seeders": 45, "leechers": 459 },
    "observed": { "peers": 0, "dhtCount": 0 }, "meta": null }
]}
```

Note the second entry: 504 claimed peers, zero observed, correctly placed below
the verified one despite a score in the hundreds.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/assess` | POST | Rank **and verify**. The one most callers want |
| `/v1/probe` | POST | Rank only — no metadata fetch, so ~900ms |
| `/v1/play` | POST | Stream the best candidate (202, returns immediately) |
| `/v1/status` | GET | Engine state: ranking, file, torrent, control plane |
| `/v1/stream` | GET | The bytes, with Range support |
| `/v1/presets` | GET | Bundled CC-BY fixtures |
| `/healthz` | GET | Liveness. Does not build a DHT |

Request body for `assess`/`probe`/`play` — any one of:

```jsonc
{ "input": "magnet:?...\n<infohash>" }    // what a human pastes
{ "candidates": [ { "infoHash": "...", "magnetURI": "...", "trackers": [] } ] }
{ "presets": true }                       // the bundled fixtures
```

`assess` also takes `verify` (default `true`), `maxPeers` (default `40`),
`concurrency` (default `6`) and `deadlineMs` (default `20000`, `0` disables).

**Timing.** `probe` is ~1s. `assess` costs more because it opens real TCP
connections to strangers. Measured cold, with nothing learned about any
address: **7.6s** to verify Sintel against 127 discovered peers. Warm, often
under 2s, because `PeerTable` promotes addresses that have answered before.

Two knobs govern that. `concurrency` is how many peers are tried at once —
cold, DHT-sourced peers measured 13% TCP-connect, so trying them one at a time
means an expected eight connect timeouts before the first live one; at 6 the
same walk finishes in seconds. `deadlineMs` caps the whole thing, and anything
unresolved when it expires comes back as `reachable` with
`verifyTimedOut: true` — *not* the same claim as "every peer was asked and
refused", so do not count it as evidence a swarm is dead.

Use `probe` when you need a fast answer and `assess` when you need a true one.

**Access.** No authentication — it binds `127.0.0.1` and holds nothing private.
Exposing it is one deliberate flag, because bound to a public address this is a
torrent client anyone who finds the port can drive, with your IP in the swarm:

```bash
ENGINE_HOST=0.0.0.0 ENGINE_ALLOW_PUBLIC=1 npm start
```

Put a proxy in front if you need auth or rate limiting.

For most integrations this is where you can stop reading. The sections below
cover the same capabilities as a library, for embedding in a Node process.

---

## As a library

```js
import SwarmScout from 'swarm-scout'          // or './swarmScout.js'
import { parseInput } from './catalog.js'

const scout = await SwarmScout.create()

const candidates = [
  parseInput('magnet:?xt=urn:btih:08ada5a7...&dn=Sintel'),
  parseInput('dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c')   // bare infohash also fine
]

// Rank and verify, sorted by verdict tier then score.
const assessed = await scout.assess(candidates)
for (const c of assessed) {
  console.log(c.label, c.verdict, c.score, c.meta?.name ?? '')
}

scout.destroy()
```

`assess(candidates, opts)` is the library twin of `POST /v1/assess` and takes
the same options — `verify`, `maxPeers`, `concurrency`, `deadlineMs`, plus a
`table` you can pass to share learned address liveness across calls:

```js
import { PeerTable } from './peerTable.js'

const table = new PeerTable()                 // reuse for the whole sweep
await scout.assess(batchOne, { table })
await scout.assess(batchTwo, { table })       // skips addresses known dead
```

Each entry is a `rank()` result plus `verdict`, `verified`, `meta`, `verifyMs`
and `verifyTimedOut`.

### Ranking without verifying

`rank()` is the fast half on its own — scrape plus DHT lookup, no metadata
fetch, no verdict.

```js
const ranked = await scout.rank(candidates)   // best first, by score
```

`parseInput` accepts a magnet link or a 40-character infohash and merges the
magnet's own trackers with a known-live default list. Build candidates by hand
if you prefer — the shape is:

```js
{ infoHash, magnetURI, trackers: [...], label }   // label is cosmetic
```

`rank()` returns every candidate, best first, including the ones that scored
zero, so you can apply your own cutoff rather than inheriting one.

```js
{
  infoHash, magnetURI, label, trackers,
  score,                 // single number, best-first ordering
  peers: [{host, port}], // addresses actually observed
  source: 'probed',      // or 'shared', when answered from the control plane
  sources: {
    seeders, leechers,   // what trackers CLAIM
    dhtCount,            // peer addresses the DHT actually returned
    peerWeight, locality,
    via, fromCache, filledFromShared
  }
}
```

### Reading a result honestly

This is the part worth slowing down for, because `score` alone will mislead
you.

`seeders`/`leechers` are **claims**. They come from a tracker scrape, which
returns counts and no addresses, and nothing verifies them. `peers` and a
successful metadata fetch are **proof** — a real address that completed a TCP
handshake and served a torrent whose SHA1 matches the infohash you asked for.

The current `score` weights claims heavily. That is fine for comparing
alternate releases of the same title against each other, and actively
misleading if you use it as a health badge. Measured, on real swarms:

| Candidate | Claimed | `peers` | Verified | `score` |
|---|---|---|---|---|
| Ubuntu 26.04.1 desktop | 310 seeders | 0 | no | 3086 |
| Sintel | 107 seeders | 202 | yes, streamed | 1959 |
| A hash that does not exist | 45 seeders | 0 | no | 958 |

A nonexistent infohash scored 958 because hundreds of clients announce to it.
So:

- **Comparing releases of one title?** `score` is the right field.
- **Deciding whether a single torrent is alive?** Use `peers.length` and a
  metadata fetch. Never `score`.

And the asymmetry that matters most: **absence of proof is not proof of
absence.** `peers.length === 0` means "we did not verify it", which covers both
a dead swarm and a healthy tracker-only one. Ubuntu is the second kind. Give it
its own state in your UI; do not render it as "dead". See
[Health badges](#pattern-health-badges-for-a-catalogue) below.

---

## Verifying a candidate

To prove a swarm is real, ask a peer for the torrent:

```js
import { fetchFromAny } from './metainfo.js'
import { PeerTable } from './peerTable.js'

const table = new PeerTable()      // reuse across hashes; learns address liveness
const meta = await fetchFromAny(infoHash, ranked[0].peers, { maxPeers: 40, table })

if (meta?.ok) {
  console.log(meta.name, meta.size, meta.files, meta.paths)
}
```

`ut_metadata` verifies SHA1(info) against the infohash before returning, so a
result here cannot be a different torrent. That is what makes it proof.

Size the peer budget to where the addresses came from. Peers from an iterative
DHT lookup on an old swarm measured **13% TCP-connect**, so 8 peers is roughly
one connection — a coin flip. Crawler peers, which come from the node that just
sampled the hash, run ~34% and 8 is plenty. Of peers that do connect, ~63%
serve metadata.

```bash
node tools/probe-magnet.mjs "magnet:?xt=urn:btih:..."
```

Does all of the above for one link and prints a verdict.

---

## Streaming

The only way to be sure a ranking was right is to play the bytes.

```js
import StreamServer from './streamServer.js'

const server = new StreamServer()
const port = await server.listen()
await server.play(ranked)          // races candidates, picks the first playable

console.log(server.file.name, server.file.length)
// http://localhost:${port}/  serves it with Range support
await server.destroy()
```

`play()` takes the ranked array and fails over automatically: if the chosen
swarm stalls, it drops to the next candidate. This is why a candidate set
should be **alternate releases of the same content** — failover assumes any
candidate substitutes for the others.

Pass `torrentFile` (a `.torrent` buffer) on a candidate and it is used instead
of the magnet. Worth doing when you have it: a magnet needs some peer to serve
metadata, and not every seed will. Ubuntu's official seed connects but refuses
`ut_metadata`, so its magnet never resolves while its `.torrent` works fine.

---

## Integration patterns

### Pattern: health badges for a catalogue

The case where this earns its keep — an index knows what it lists but not what
still works. Tracker counts it already has; what it cannot get elsewhere is
whether a peer will actually answer.

The verdict is the badge:

```js
const [r] = await scout.assess([candidate], { table })
// r.verdict -> 'verified' | 'reachable' | 'claimed' | 'none'
```

Or over HTTP, if your index is not a Node process:

```bash
curl -X POST localhost:8080/v1/assess -d '{"input":"magnet:?..."}'
```

Render four states, not two. Collapsing `claimed` into `dead` hides working
torrents; collapsing it into `verified` is how a nonexistent hash gets 459
leechers and a green badge.

Keep `claimed.seeders` visible next to the badge rather than instead of it.
Your users are used to seeing a seeder count, and the honest presentation is
both — the count as reported, and the verdict as established.

One probe is weak evidence either way. Re-probe on a schedule and let a badge
move to `dead` only after repeated failures — a single miss is often a closed
DHT window, not a dead swarm.

### Pattern: pick the best release

You have five releases of one title and want the one that will actually play.

```js
const ranked = await scout.rank(releases)
await server.play(ranked)     // failover is built in
```

Here `score` is the right instrument: the candidates are substitutes, so their
relative order is what matters and the absolute number does not.

### Pattern: dead-link sweep

Walk your catalogue in batches, keep what verifies, flag what never does across
several runs. `PeerTable` reused across the whole sweep will skip addresses it
has already learned are unreachable, which is most of the cost.

### Pattern: inside a fleet

On a private network, asking a public DHT about hosts you could simply connect
to is slower and a worse liveness signal.

```bash
SWARM_SCOUT_MEMBERS=10.4.1.7:6881,10.4.1.8:6881
SWARM_SCOUT_LOCAL_CIDRS=10.4.1.,10.4.2.
```

Peers are then probed directly with a real handshake, and `locality.js` weights
rack-local peers above distant ones so four nearby seeders outrank twenty
far-away ones.

---

## Optional: the control plane

A Cloudflare Worker that lets clients share swarm health and live DHT bootstrap
nodes. Strictly an accelerator — every call is deadline-capped and fails to
`null`, and with it switched off the client behaves exactly as it does without
it.

```bash
npm run worker:deploy
```

Then point clients at it:

```bash
SWARM_SCOUT_API=https://your-worker.workers.dev
```

What it buys: a cold decision that would cost a full local probe can be
answered from shared health instead, and a cold client gets known-live
bootstrap nodes rather than only the public ones.

You do not need it. Skip it entirely if you are running one client.

---

## Optional: the crawler

Separate from everything above, and separately optional.

`rank()` needs infohashes you already have. The crawler is where you get
infohashes when you have none: BEP 51 `sample_infohashes` asks DHT nodes for a
random sample of what they currently store, and BEP 9 resolves names from
peers. It writes `.dht-index.db`.

```bash
npm run crawl                      # long-running harvest
npm run crawl -- --stats           # what the index holds
npm run crawl -- --search "…"      # search resolved names
```

**It is harvesting, not searching.** It takes whatever drifts past its node.
Coverage accumulates over hours, skews toward whatever is announced most, and
never guarantees a given title turns up.

It shares `metainfo.js`, `peerTable.js` and `contentFilter.js` with the ranking
path, so it is not a bolt-on — but nothing in `rank()` or `StreamServer` needs
it, and it never runs unless you start it. If your candidates come from your
own catalogue, you will never touch it.

`contentFilter.js` gates persistence. An unfiltered BEP 51 crawl indexes
whatever the network holds, which within minutes includes material you do not
want on disk. Matching is over the name **and every file path**, and the action
is delete rather than flag. Do not disable it.

---

## Configuration

Everything is optional. Copy `.env.example` to `.env`.

| Variable | Default | Effect |
|---|---|---|
| `SWARM_SCOUT_API` | unset | Control-plane endpoint. Unset = fully local |
| `SWARM_SCOUT_MEMBERS` | unset | `host:port,…` roster; switches to direct fleet probing |
| `SWARM_SCOUT_MODE` | `dht` / `fleet` | Force a peer source |
| `SWARM_SCOUT_LOCAL_CIDRS` | unset | `10.4.1.,10.4.2.` prefixes treated as rack-local |
| `ENGINE_PORT` | `8080` | HTTP API port |
| `ENGINE_HOST` | `127.0.0.1` | Bind address for the HTTP API |
| `ENGINE_ALLOW_PUBLIC` | unset | Required to bind anything other than loopback |

Tuning constants (probe budgets, DHT window, scrape grace, filter thresholds)
live at the top of their own modules and are documented in README's *Tuning*
section. The measured ones are already at sensible values — the DHT window
saturates at 900ms on a live swarm, so widening it buys nothing.

---

## Checking your integration

```bash
node tools/real-world-test.mjs
```

Runs the whole pipeline against the real network — control plane, ranking, a
negative control that exists nowhere, metadata off a live peer, the content
filter, and a piece-verified Range request — and prints pass/fail per stage.
Use it to confirm your environment can actually reach the network before
debugging your own code.

```bash
node tools/probe-magnet.mjs "magnet:?..."   # one link, one verdict
npm run smoke                               # rank → stream → seek
npm run check-bootstrap                     # which DHT bootstrap nodes answer
```

---

## Gotchas worth knowing up front

- **A zero is ambiguous.** A failed scrape and an empty swarm both produce 0.
  Treat "learned nothing" and "nothing there" as different states everywhere.
- **The DHT is not universal.** Some healthy swarms have no reachable DHT
  presence at all; Ubuntu returned 0 peers at every window up to 15 seconds
  while Sintel saturated at 202 by 900ms. Trackers are the only path for those,
  and scrape gives no addresses.
- **Do not block on `scout.ready()`** before ranking. Lookups work against a
  partly-populated routing table; waiting costs ~5s and buys nothing.
- **`destroy()` both** the scout and the stream server, or the process will not
  exit.
- **Sockets, not requests.** This opens real TCP connections to strangers.
  Behind a restrictive firewall or CGNAT expect a much lower connect rate than
  the numbers above.
