<div align="center">

# swarmproof

**Proves a BitTorrent swarm is alive by pulling the torrent from a real peer —
instead of trusting a seeder count that nothing ever checked.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)](package.json)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%C2%B7%20KV%20%C2%B7%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](ARCHITECTURE.md)

</div>

---

## See it in ten seconds

```bash
git clone https://github.com/EagleMind/swarmproof.git
cd swarmproof && npm install && npm run prove-it
```

No server, no signup, no configuration. It builds an engine in process, talks
to the live BitTorrent network from your machine, and tears it down. Takes
about fifteen seconds, most of which is the DHT bootstrapping cold.

Two infohashes. One is a real film. The other has never existed — it is the
junk drawer of the BitTorrent DHT, and broken clients announce to it around
the clock. Here is what the public trackers say about each:

```
  WHAT THE TRACKERS CLAIM  — a number nothing verifies

    A hash that has never existed         38 seeders    663 leechers   1128 peers seen
    Sintel (2010, CC-BY)                 114 seeders     76 leechers    381 peers seen
```

The hash that cannot exist reports **three times as many peers** as the film
that does. No seeder count, no peer count, and no combination of the two
separates them. Now ask a peer for the actual torrent:

```
  WHAT A PEER ACTUALLY SERVED  — SHA1(info) checked against the hash

    A hash that has never existed       UNPROVEN   refuted — 1128 peers asked, none had it
    Sintel (2010, CC-BY)                  PROVEN   Sintel · 129 MB · 11 files
```

That is the whole idea. Every health signal in this ecosystem is a number
someone reported. This one is a file a peer handed over, hashed, and checked.

---

## The four verdicts

Not two. Two of these look like failure and are not, and collapsing them is
how a working torrent gets hidden — or a nonexistent one gets a green badge.

| verdict | what was established | safe to call dead? |
|---|---|---|
| `verified` | a peer served the real torrent, SHA1-matched | it is alive |
| `reachable` | addresses found, none served metadata in time | **no** — unknown |
| `claimed` | trackers report a swarm, no address obtained | **no** — some healthy torrents live here permanently |
| `none` | no signal anywhere | only after repeated checks |

A `reachable` result that carries `refuted: true` is the strong one: peers
were found *and asked*, and none of them had it. That is evidence of absence
rather than absence of evidence, and it is the only thing that separates a
real swarm from a hash people merely announce to. Its score is damped and it
sorts below `claimed`, because having looked and found nothing is a worse
sign than not having looked.

Results sort by verdict tier first and score second, so nothing unproven can
outrank something proven.

> **`score` orders candidates. It never establishes that one is alive.** It
> weights tracker claims heavily and those are unverifiable by construction.
> Comparing releases of one title? Use `score`. Deciding whether a single
> torrent is alive? Use `verdict`, never `score`.

---

## Who this is for

You are distributing something over BitTorrent and need to know the swarm is
alive **before** you tell people to download it:

- **Release and CI pipelines.** You publish Linux images, game patches, model
  weights or datasets by torrent. Verify the swarm is servable before the
  announcement goes out, and alert when it decays.
- **Catalogue and index operators.** You list torrents you did not create. You
  already have tracker counts; what you cannot get anywhere else is whether a
  peer will actually answer. Dead-link sweeps, honestly badged.
- **Archives and preservation.** Watch whether a preserved collection still
  has a servable swarm, and get warned before the last seed disappears.
- **Fleet and internal distribution.** Images and datasets across a cluster,
  weighted so rack-local peers beat distant ones and cross-AZ egress stays
  down.
- **Anyone choosing between mirrors.** Five copies of one thing, one decision
  in about a second, and the ranking doubles as the failover order.

It is a **peer-discovery layer**: no indexer, no catalogue, no content, and no
way to search for a title by name. You bring the infohash.

> **Legality.** Point this at material you have the right to distribute. The
> bundled fixtures are Blender Foundation open movies (CC-BY). The crawler
> samples infohashes the DHT already publishes, stores hashes and names but
> never peer lists, and everything it finds passes a
> [content filter](#what-never-enters-the-index) before it is written.

---


## Quick start

**There is no hosted endpoint.** This ran as a public API for a while and the
deployment is documented in [`deploy/`](deploy/README.md), including the
Worker front door in [`worker-api/`](worker-api/src/index.js) that fronted it.
It was taken down deliberately: an engine is a BitTorrent client, so whoever
runs it is the address in every swarm a caller asks about, and that is not a
liability worth carrying for a demo. Run your own — it is one command and it
has no ceilings.

```bash
npm install
```

Use it as a service, or as a library. Both are first class.

```bash
npm start
```

```bash
curl -X POST localhost:8080/v1/assess \
  -H 'content-type: application/json' \
  -d '{"input":"magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10"}'
```

```json
{ "label": "Sintel", "verdict": "verified", "score": 2029,
  "claimed":  { "seeders": 115, "leechers": 51 },
  "observed": { "peers": 121, "dhtCount": 202 },
  "meta": { "name": "Sintel", "size": 129302391, "files": 11 } }
```

Or in Node:

```js
const scout = await SwarmScout.create()
const [best] = await scout.assess(candidates)   // verdict, meta, score
```

Full contract in the OpenAPI 3.1 spec at
[`worker-docs/src/openapi.js`](worker-docs/src/openapi.js) — hand-written, and
servable with `npm run docs:dev` if you want it rendered.

No authentication — it binds loopback and holds nothing private. Exposing it
takes `ENGINE_HOST=0.0.0.0 ENGINE_ALLOW_PUBLIC=1`, deliberately explicit,
because a public bind is a torrent client anyone who finds the port can drive.

| Command | What it does |
|---|---|
| `npm run prove-it` | The demonstration above, against the live network |
| `npm start` | The engine as an HTTP service on `:8080` |
| `npm run e2e` | Exercise the deployed API end to end, with a full wire trace |
| `npm run demo` | Rank the example candidates and stream the winner |
| `npm run crawl` | Run the BEP 51 crawler (`-- --stats`, `-- --search "…"`) |
| `npm run smoke` | End-to-end: rank → stream → exercise Range requests and seeking |
| `npm run bench` | Scenario matrix + rank-accuracy harness (`-- --api <url>`) |
| `npm run loadtest` | Synthetic clients against the control plane |
| `npm run check-bootstrap` | Ping every DHT bootstrap node, report which answer |
| `npm run worker:deploy` | Deploy the control plane |
| `npm run docs:deploy` | Deploy the OpenAPI reference |

---

## As a library

The HTTP routes are documented in full in
[`worker-docs/src/openapi.js`](worker-docs/src/openapi.js). This is the other
half: the same capabilities inside a Node process, which is what
[`server.js`](server.js) itself calls.

```js
import SwarmScout from 'swarmproof'          // or './swarmScout.js'
import { parseInput } from './catalog.js'

const scout = await SwarmScout.create()

const candidates = [
  parseInput('magnet:?xt=urn:btih:08ada5a7...&dn=Sintel'),
  parseInput('dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c')   // bare infohash also fine
]

const assessed = await scout.assess(candidates)
for (const c of assessed) console.log(c.label, c.verdict, c.score, c.meta?.name ?? '')

scout.destroy()
```

`assess(candidates, opts)` is the twin of `POST /v1/assess` and takes the same
options — `verify` (default `true`), `maxPeers` (`40`), `concurrency` (`6`),
`deadlineMs` (`20000`, `0` disables) — plus one the HTTP API cannot expose: a
`table` you pass across calls so learned address liveness is shared.

```js
import { PeerTable } from './peerTable.js'

const table = new PeerTable()                 // reuse for the whole sweep
await scout.assess(batchOne, { table })
await scout.assess(batchTwo, { table })       // skips addresses known dead
```

`rank()` is the fast half alone — scrape plus DHT lookup, no metadata fetch, no
verdict. It returns every candidate, best first, including the ones that scored
zero, so you apply your own cutoff rather than inheriting one:

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

`parseInput` takes a magnet link or a 40-character infohash and merges the
magnet's own trackers with the known-live list. Build candidates by hand if you
prefer — the shape is `{ infoHash, magnetURI, trackers, label }`, and `label`
is cosmetic.

To verify one candidate directly, ask a peer for the torrent. `ut_metadata`
checks SHA1(info) against the infohash before returning, which is what makes it
proof rather than a report:

```js
import { fetchFromAny } from './metainfo.js'

const meta = await fetchFromAny(infoHash, ranked[0].peers, { maxPeers: 40, table })
if (meta?.ok) console.log(meta.name, meta.size, meta.files, meta.paths)
```

Size that peer budget to where the addresses came from. Peers from an iterative
DHT lookup on an old swarm measured **13% TCP-connect**, so 8 peers is roughly
one connection — a coin flip. Crawler peers, which come from the node that just
sampled the hash, run ~34%, and 8 is plenty. Of peers that do connect, ~63%
serve metadata.

Streaming is its own object, and `play()` takes the ranked array so failover is
automatic — if the chosen swarm stalls it drops to the next candidate. That is
why a candidate set should be **alternate releases of the same content**:
failover assumes any candidate substitutes for the others.

```js
import StreamServer from './streamServer.js'

const server = new StreamServer()
const port = await server.listen()
await server.play(ranked)          // races candidates, picks the first playable
// http://localhost:${port}/  serves it with Range support
await server.destroy()
```

Pass `torrentFile` (a `.torrent` buffer) on a candidate and it is used instead
of the magnet. Worth doing when you have it: a magnet needs some peer to serve
metadata, and not every seed will — Ubuntu's official seed connects but refuses
`ut_metadata`, so its magnet never resolves while its `.torrent` works fine.

### Reading a result honestly

This is the part worth slowing down for, because `score` alone will mislead
you.

`seeders`/`leechers` are **claims**. They come from a tracker scrape, which
returns counts and no addresses, and nothing verifies them. `peers` and a
successful metadata fetch are **proof** — a real address that completed a TCP
handshake and served a torrent whose SHA1 matches the infohash you asked for.

The current `score` weights claims heavily. That is fine for comparing
alternate releases of one title, and actively misleading as a health badge:

| Candidate | Claimed | `peers` | Verified | `score` |
|---|---|---|---|---|
| Ubuntu 26.04.1 desktop | 310 seeders | 0 | no | 3086 |
| Sintel | 107 seeders | 202 | yes, streamed | 1959 |
| A hash that does not exist | 45 seeders | 0 | no | 958 |

- **Comparing releases of one title?** `score` is the right field.
- **Deciding whether a single torrent is alive?** Use `verdict`, or
  `peers.length` plus a metadata fetch. Never `score`.

And the asymmetry that matters most: **absence of proof is not proof of
absence.** `peers.length === 0` covers both a dead swarm and a healthy
tracker-only one; Ubuntu is the second kind. Give it its own state in your UI
rather than rendering it as dead, keep `claimed.seeders` visible *next to* the
verdict rather than instead of it, and let a badge move to dead only after
repeated failures — a single miss is often a closed DHT window.

### Gotchas worth knowing up front

- **A zero is ambiguous.** A failed scrape and an empty swarm both produce 0.
  Treat "learned nothing" and "nothing there" as different states everywhere.
- **The DHT is not universal.** Some healthy swarms have no reachable DHT
  presence at all; Ubuntu returned 0 peers at every window up to 15 seconds
  while Sintel saturated at 202 by 900ms. Trackers are the only path for those,
  and a scrape gives no addresses.
- **Do not block on `scout.ready()`** before ranking. Lookups work against a
  partly-populated routing table; waiting costs ~5s and buys nothing.
- **`destroy()` both** the scout and the stream server, or the process will not
  exit.
- **Sockets, not requests.** This opens real TCP connections to strangers.
  Behind a restrictive firewall or CGNAT expect a much lower connect rate than
  the numbers below.

Check the whole pipeline against the real network before debugging your own
code — control plane, ranking, a negative control that exists nowhere, metadata
off a live peer, the content filter, and a piece-verified Range request, with
pass/fail per stage:

```bash
node tools/real-world-test.mjs
```

---

## Benchmarks

Measured against the live BitTorrent network from one machine. No figure here
is estimated. Reproduce with `npm run bench` and `node tools/crawl-bench.mjs`.

### Time to decision

From "here are candidate infohashes" to "stream this one" — the wait before
playback can begin. Seven repetitions, scenarios interleaved with the starting
offset rotated each rep, because DHT bootstrap alone varies 2.5–5.6s and
running scenarios in sequence biases the later ones.

| Scenario | median | p90 | blocking wait on control plane |
|---|---|---|---|
| Cold client, no control plane | 909ms | 916ms | 0ms |
| Warm client, no control plane | 907ms | 927ms | 0ms |
| Cold client, control plane hit | **60ms** | 77ms | 60ms |
| Warm client, control plane hit | 57ms | 75ms | 57ms |
| Control plane unreachable | 1,214ms | 1,219ms | 309ms |

**Read the 60ms carefully.** It is a cache *hit* — the answer for content
someone else already asked about. A first-of-its-kind infohash, a new release
or something obscure, is a miss by definition and costs the full ~900ms probe
plus the lookup. The control plane makes popular content fast. It cannot make
the long tail fast, and it does not pretend to;
[Staleness and trust](#staleness-and-trust) covers what it returns instead.

An unreachable control plane costs **+309ms**, measured directly rather than
differenced between scenarios, after which one capped timeout opens a circuit
breaker and the client stops calling. That cost is the bar it has to clear: it
must stay below what probing locally would have cost anyway.

### Streaming

| | |
|---|---|
| Cold time to first video byte | ~2.6s |
| Tracker scrape, first answer | 133–147ms |
| First DHT peer | 844ms |
| Throughput | ~2.7 MB/s |
| Seek into a buffered region | first bytes in ~5ms |
| Invalid Range | `416` with `Content-Range: bytes */total` |

### Ranking accuracy

Latency is worthless if the answer is wrong. Being off by ten seeders does not
matter; picking the wrong swarm does.

| Candidate | shared (s/l) | fresh probe (s/l) | seeder error |
|---|---|---|---|
| Sintel | 120 / 49 | 120 / 49 | 0 (0.0%) |
| Big Buck Bunny | 255 / 32 | 255 / 32 | 0 (0.0%) |
| Cosmos Laundromat | 62 / 5 | 62 / 5 | 0 (0.0%) |

Same winner, same order, **zero rank inversions** at 155s staleness, stable
across every run taken so far.

### Crawler

Single instance, five-minute window, `node tools/crawl-bench.mjs --minutes 5`:

| | |
|---|---|
| **Names resolved** | **627.6/min** |
| Hashes harvested | ~12,800/min |
| Blocked by the content filter | 120 |
| Nodes queried | 11,185 → 42,008 addresses found |
| Sampled → had peers | 56,367 → 19,625 (34.8%) |
| Metadata attempted → named | 19,625 → 3,155 (16.1%) |
| Dead peer addresses skipped | 9,377 |

For scale, [bitmagnet](https://bitmagnet.io/faq.html) — the reference Go
implementation — publishes 100–1,000 torrents/minute.

The rate reaches steady state in about two minutes, as the node table learns
which nodes answer BEP 51. Measure with the crawler's own `stats.named`, not
`COUNT(*)` on the database: the row count includes every process writing the
same index, so two crawlers at once read as one very fast one.

### Scale

The control plane, driven by synthetic clients:

| | |
|---|---|
| 5,000 clients / 10,000 read requests | 1,060 req/s, 0.00% errors (p50 77–84ms, p99 196–411ms) |
| 3,000 distinct infohashes | 3,000/3,000 written and read back intact |
| Hot key, 2,000 clients on one infohash | 1 write, 0 errors — a Durable Object per infohash coalesces |
| Validation under load | no malformed or private-IP data accepted at any concurrency |
| KV write-to-read propagation | ~50s |

---

## Also in here

The two sections below are real, working, and **not what this project is
for**. They exist because each answers a question the core one raised, and
neither is deployed on the hosted endpoint: the crawler has no API route at
all, and the streaming routes return `501` there. Skip both unless you
specifically want them.

### The crawler

The DHT is a hash table, not a search engine. `get_peers` resolves an infohash
you already have; there is no query for *the film called Sintel*.
[BEP 51][bep51] adds `sample_infohashes`, which asks a node for a random sample
of what it currently stores. Resolve those names over BEP 9 and the network
indexes itself.

[bep51]: https://www.bittorrent.org/beps/bep_0051.html

Be clear about what this is: **harvesting, not searching**. It takes whatever
drifts past its node. Coverage accumulates over hours and days, skews toward
whatever is announced most often, and never guarantees a particular title
appears.

```bash
npm run crawl
```

### Four stages

```
find_node        sample_infohashes     get_peers        ut_metadata
UDP              UDP, BEP 51           UDP              TCP, BEP 9
keep the node    which hashes          who has one      what is it
supply flowing   exist                 of them          called
```

**`get_peers` is the stage an obvious implementation leaves out, and its
absence caps everything downstream.** Handing a bare infohash to a torrent
client asks it to rediscover the swarm from nothing. But the node that just
offered that hash is, by definition, storing it — the best lead available, and
free, because it is one more UDP round trip to an address already in hand.
Against the alternative on the same 60 hashes: a direct `get_peers` to the
sampling node hits 38.3% in 298ms, while a full iterative `dht.lookup()` hits
5.0% in 6,013ms and finds nothing the direct probe missed.

**`find_node` looks like scaffolding and is not.** Sampling consumes nodes
permanently — one that answers is backed off for the interval it requests, one
that does not is written off as not implementing BEP 51 — so a crawl fed only
by `sample_infohashes` replies runs dry within about ninety seconds.
`find_node` is answered by *every* DHT node, including the majority that ignore
BEP 51, which makes it a supply rather than another filter.

**Metadata comes over a raw TCP wire** — `bittorrent-protocol` plus
`ut_metadata`, no torrent client. A client builds a torrent object, a piece
store, a discovery loop and a swarm in order to read a few hundred bytes of
bencode, which is why an implementation built on one manages a handful of
concurrent lookups where this manages three hundred. Connect, handshake, ask,
hang up. Nothing is downloaded and nothing is written to disk.

### Two structures the stages share

[`peerTable.js`](peerTable.js) carries **address liveness** across hashes. The
reusable asset is not the peers themselves — a peer serves metadata only for
torrents it holds — but the address: only ~13% of the addresses the DHT hands
back accept a connection at all, the same ones recur constantly, and re-paying
a connect timeout per hash to rediscover that dominates the naming stage.
Known-dead addresses are skipped for free; known-good ones are tried first,
ordered by measured connect RTT.

**Backpressure sits between `get_peers` and naming.** Naming consumes roughly
ten hashes a second where the peer stage produces sixty — one is TCP to
arbitrary internet hosts, the other a single UDP round trip — so that boundary
needs a policy rather than a bounded push that silently discards the overflow.
The producer waits, and `stats.dropped` makes the imbalance visible.

### What never enters the index

A BEP 51 crawler does not choose what it finds. It samples whatever the network
is storing, and the network stores everything, including material this project
will not hold.

[`contentFilter.js`](contentFilter.js) gates persistence. It is ported from
[bitmagnet](https://github.com/bitmagnet-io/bitmagnet) (MIT), which solves this
in its classifier: `internal/classifier/classifier.core.yml` carries the
`banned` keyword list and a workflow whose first action deletes anything
matching it, compiled by `internal/keywords/parser.go`. Three cheap junk checks
come from `internal/protocol/metainfo/banning/` — name ≥ 8 characters, size ≥
1KB, valid UTF-8.

Two properties are copied exactly, because both are easy to get subtly wrong:

**It matches the name *and every file path*, joined.** A torrent whose name
looks innocuous routinely carries the real content in its file names, so a
name-only filter misses precisely the cases that matter most. This is why
[`metainfo.js`](metainfo.js) returns file paths rather than a count.

**The action is delete, not flag.** No name is written, so there is no row to
leak through a query that forgets a `WHERE` clause. The infohash is retained
and marked blocked, purely so the crawl does not rediscover and re-fetch it.

The keywords are a small DSL rather than raw regex, and compiling them naively
would both over- and under-match:

```
wrapper   (?:^|\W+) ( kw | kw | ... ) (?:$|\W+)    bounded, so a keyword
                                                   cannot fire mid-word
per-kw    *  ->  \w*        #  ->  \d        space  ->  \W
          (x)? optional     |  alternation   \x literal
```

```bash
node tools/filter-index.mjs --dry-run
```

applies the same rules to names already stored. That pass is **weaker than the
live filter**: stored rows keep only a file count, so it can check names alone.
A row it clears means "the name does not match", not "this torrent is fine".

---

## Staleness and trust

Two things the control plane's API is explicit about, because getting either
wrong is worse than having no control plane at all.

**Every health entry carries its own age.** Swarm health is time-volatile —
seeders come and go on the order of minutes — so a number without an age is a
rumour, not an answer. `/v1/health` returns `ts`, `age` and a `confidence`
tier:

| tier | age | meaning |
|---|---|---|
| `fresh` | ≤ 2 min | decide on this |
| `recent` | ≤ 10 min | usable; matches the client's own re-probe threshold |
| `stale` | > 10 min | do not decide on this alone — probe |

The client honours the tier *and* re-checks the age locally, because the
server's clock, the edge cache and the wire all add age after the tier was
computed. A caller that treats a twelve-minute-old reading as current will
promote a dead candidate and burn a stall cycle discovering it. Probing locally
costs ~900ms; being wrong costs a playback stall.

**Reported numbers are not corroborated, and the API does not pretend
otherwise.** Reporting is unauthenticated and there is no identity, so the
stored write count is not published: a field reading `reports: 15` would look
exactly like fifteen independent parties agreeing, and a caller would
reasonably weight it that way. Values are bounded — a single report cannot
claim more than 250,000 seeders — and a report of all zeros cannot erase a
positive reading. Neither of those makes a number trustworthy. Treat health as
a hint that saves a probe, never as an authority. The threat model, and what a
reputation layer would have to provide, are in
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## DHT bootstrap nodes

Most published bootstrap lists are stale. Measured from a real connection, four
ping attempts each, by DNS name and by hardcoded IP:

| Node | Result |
|---|---|
| `dht.libtorrent.org:25401` | **alive** 4/4, best 59ms |
| `dht.transmissionbt.com:6881` | **alive** 4/4, best 49ms |
| `router.bittorrent.com:6881` | dead 0/3 (also dead at `67.215.246.10`) |
| `router.utorrent.com:6881` | dead 0/3 (also dead at `82.221.103.244`) |
| `dht.aelitis.com:6881` | dead 0/4 |
| `dht.bitcomet.com` | no DNS record at all |
| `router.silotis.us:6881` | **AAAA only** — unreachable from an IPv4 DHT socket |

This is not rate-limiting or DNS filtering: the dead names resolve fine, and
pinging their hardcoded IPs fails identically. They simply do not answer.
`router.silotis.us` is not dead, it is IPv6-only, and is left out of the default
list rather than deleted on a false premise.

Re-verify with `npm run check-bootstrap`. The routing table is flushed to disk
on every rank and on shutdown, and cached nodes go **ahead of** the public
domains next start — `bittorrent-dht` gates its `ready` event on the bootstrap
pass, so nodes added afterwards enrich the table but do nothing for
time-to-ready.

---

## Layout

| File | Role |
|---|---|
| [`swarmScout.js`](swarmScout.js) | Parallel probe, weighted scoring, `assess()` verdicts |
| [`streamServer.js`](streamServer.js) | WebTorrent + HTTP Range server, playhead prioritisation, stall failover |
| [`dhtCrawler.js`](dhtCrawler.js) | BEP 51 sampling, `get_peers`, name resolution, SQLite index |
| [`metainfo.js`](metainfo.js) | BEP 9 metadata over a raw TCP wire |
| [`peerTable.js`](peerTable.js) | Address liveness and RTT, reused across every hash |
| [`contentFilter.js`](contentFilter.js) | Gate on persistence |
| [`peerCache.js`](peerCache.js) | SQLite cache: per-infohash peers/score plus the DHT routing table |
| [`peerSources.js`](peerSources.js) | Peer acquisition, including measured handshake RTT |
| [`locality.js`](locality.js) | Weights each peer by how reachable it is — RTT, then address |
| [`cloudCache.js`](cloudCache.js) | Control-plane client. Deadline-capped, fail-silent, circuit breaker |
| [`catalog.js`](catalog.js) | Candidate construction: magnet/infohash parsing, live tracker list |
| [`server.js`](server.js) | The HTTP API: assess, probe, play, stream |
| [`worker/src/index.js`](worker/src/index.js) | The Worker: health cache, node pool, cron aggregator, DO coalescer |
| [`worker-docs/src/openapi.js`](worker-docs/src/openapi.js) | OpenAPI 3.1 spec, served by its own Worker |

Measurement tools: [`crawl-bench`](tools/crawl-bench.mjs) (names/min and stage
conversion), [`peer-yield`](tools/peer-yield.mjs) (direct `get_peers` versus
iterative lookup), [`connect-timing`](tools/connect-timing.mjs) (where a
metadata fetch spends its time), [`benchmark`](tools/benchmark.mjs),
[`loadtest`](tools/loadtest.mjs),
[`check-bootstrap`](tools/check-bootstrap.mjs),
[`filter-index`](tools/filter-index.mjs).

---

## Configuration

Everything is optional — with an empty `.env` the discovery layer works exactly
as it does with a full one. Copy [`.env.example`](.env.example) to `.env`.

| Variable | Default | Effect |
|---|---|---|
| `SWARMPROOF_API` | unset | Control-plane endpoint. Unset = fully local |
| `SWARMPROOF_MEMBERS` | unset | `host:port,…` roster; switches to direct fleet probing |
| `SWARMPROOF_MODE` | `dht` | `fleet` forces the member roster as the peer source |
| `SWARMPROOF_LOCAL_CIDRS` | unset | `10.4.1.,10.4.2.` prefixes treated as rack-local |
| `ENGINE_PORT` | `8080` | HTTP API port |
| `ENGINE_HOST` | `127.0.0.1` | Bind address for the HTTP API |
| `ENGINE_ALLOW_PUBLIC` | unset | Required to bind anything other than loopback |

Inside a fleet, asking a public DHT about hosts you could simply connect to is
both slower and a worse liveness signal. Set the roster and the local prefixes
and peers are probed directly with a real handshake, with
[`locality.js`](locality.js) weighting rack-local peers above distant ones so
four nearby seeders outrank twenty far-away ones.

The remaining knobs are constants at the top of their own modules rather than
environment variables, because changing one is a decision that wants the
comment next to it:

---

## Tuning

### Ranking

- `DHT_CONCURRENCY` (300) — in-flight KRPC queries on the shared DHT socket.
  **`k-rpc` defaults this to 16 for the entire socket**, and it is the ceiling
  under everything that speaks to the DHT. A queued query is indistinguishable
  from an ignored one, so raise it first when DHT throughput plateaus.
- `DEFAULT_BUDGET_MS` (1500ms) — per-candidate probe ceiling, excluding bootstrap.
- `DHT_WINDOW_MS` (900ms) — how long to collect DHT peers once the lookup fires.
  Widen it if accurate DHT counts matter more than a fast ranking.
- `SCRAPE_TIMEOUT_MS` (1200ms) / `SCRAPE_GRACE_MS` (300ms) — per-tracker
  ceiling, and how long to wait for a better answer after the first lands.
- Score weights (`seeders*10 + dht*4 + leechers*1`) plus the locality weighting
  in [`locality.js`](locality.js).

### Crawling

- Stage concurrency — 20 finders / 40 samplers / 100 peer lookups / 300 metadata
  fetchers. Not independent: the first three share the DHT socket with ranking
  and are bounded by `DHT_CONCURRENCY`, while metadata holds its own TCP
  connections and scales separately.
- `META_QUEUE_MAX` (2000) — hashes waiting to be named. The producer waits when
  full; `stats.dropped` should stay at zero.
- `DEFAULT_CONNECT_TIMEOUT_MS` (1200ms) — TCP connect, deliberately separate
  from the 6s overall budget. Two thirds of DHT-supplied addresses never
  complete a connect, while those that do are p50 141ms and max 520ms, so a
  dead peer costs a fraction of a live one instead of the same.
- `PEERS_PER_HASH` (8) — addresses to try before writing a hash off.
- `BUSY_NODE_INTERVAL_S` (60) — override for the six-hour backoff most nodes
  request, applied only while a node is still yielding unseen hashes.

### Streaming

`STALL_CHECK_MS` / `STALL_GRACE_MS` / `STALL_STRIKES` /
`STALL_MIN_BYTES_PER_CHECK`, and `HEAD_TAIL_BYTES` (2MB).

---

## Status

A portfolio project, and honest about it. Everything here runs — there is a
demo you can execute in one command, a benchmark suite, and an end-to-end
check — but nothing is hosted and nothing is on call.

The three Cloudflare Workers in this repo (`worker/`, `worker-api/`,
`worker-docs/`) and the EC2 deployment in [`deploy/`](deploy/README.md) were
all live for a period and were taken down deliberately. Two reasons, in order
of weight:

**A public engine is a liability, not a feature.** It is a BitTorrent client
with an HTTP API and no authentication it could reasonably have. Whoever runs
it puts their address into every swarm a stranger names. Fronting it with rate
limits and a shared secret bounds the volume, not the exposure.

**It cost about $20 a month**, which is not much for infrastructure and is a
lot for a demo that a single command reproduces locally.

The code for all of it is still here, because how it was deployed is part of
the work: the two-plane split, the Worker front door, the Sybil-resistant node
aggregation, the reasons `/v1/stream` was never proxied through the edge.
[`deploy/README.md`](deploy/README.md) is a complete runbook if you want to
stand one up yourself.

If it is useful to you, a tip is welcome and buys nothing — there is no gated
feature and no infrastructure left to fund:

```
bc1qwm633v8fydc0yatxf7mqlyfey7tetzzp94egmt
```

---

## What this deliberately excludes

- **A catalogue or an indexer client.** This layer answers "which of these
  swarms is alive", never "what exists" or "who has it". `candidates` in
  [`index.js`](index.js) and `PRESETS` in [`catalog.js`](catalog.js) are
  fixtures — Blender Foundation open movies whose relative health is known in
  advance, so a ranking that disagrees is a bug in the scorer rather than a
  quiet swarm.
- **Peer lists in the control plane.** A DHT routing node is infrastructure; a
  peer address is evidence of who is transferring what. That line is deliberate.
- **PEX and LSD.** Both are handled by WebTorrent once there are live peers.
- **Anonymisation or anti-takedown infrastructure.** This is a discovery layer,
  not an evasion toolkit.

## A note on package versions

`webtorrent`, `bittorrent-tracker` and `bittorrent-dht` are ESM-only in their
current majors. `package.json` sets `"type": "module"` and all source uses
`import`/`export`; `require()`-based BitTorrent snippets from older tutorials
will not work against these versions.

## License

[MIT](LICENSE.md) © 2026 Hassen Ben Mbarek
