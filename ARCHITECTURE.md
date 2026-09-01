# swarmproof architecture

How the Node client and the Cloudflare control plane divide the work, why
the split is forced rather than chosen, and what it measurably buys.

§1–§7 concern that split. The DHT crawler (§8) sits outside it entirely —
it is pure data plane, touches no Worker, and is documented separately
because it answers a different question: not *which of these swarms is
healthy* but *what is out there at all*.

§1a covers a third Worker, the **front door**, which is a different kind of
thing again: it is not part of how the software works, it is what makes one
particular instance of it safe to point strangers at.

---

## 1. Two planes

```
Node client — DATA PLANE                Cloudflare — CONTROL PLANE
────────────────────────                ──────────────────────────
DHT lookups        (UDP/KRPC)  ─┐
Tracker scrape     (UDP BEP15)  ├── reports ──▶  Worker ──▶ KV
Peer wire          (TCP/µTP)    │               ▲ cron aggregator
Piece scheduler                ─┘  ◀── hints ───┘
HTTP range server
```

The client does everything that touches the BitTorrent network. The
Worker never speaks to a peer, a tracker, or the DHT. It is shared memory
between clients that already did that work.

## 1a. The front door, and why it is not part of the engine

Everything above describes software you run. The hosted endpoint at
`swarmproof-api.hassen-ben-mbarek.workers.dev` is something else: one
instance of that software, made safe to expose.

```
caller
  │  no key, no signup
  ▼
Worker  (worker-api/)      rate limit · request caps · 60s edge cache
  │  x-engine-secret
  ▼
nginx :8443 on EC2         rejects anything unsigned
  │
  ▼
engine :8080, loopback     the actual BitTorrent client
```

**The engine has no authentication and deliberately never will.** It is a
BitTorrent client with an HTTP control API; giving it a credential store
would burden every self-hosted copy with something it does not want, and
`server.js` refuses to bind a non-loopback address without an explicit
`ENGINE_ALLOW_PUBLIC=1` precisely to keep that decision conscious. So the
public-facing concerns live entirely in front of it, in a layer a
self-hoster never deploys.

**What the front door owns is bounding, not identity.** There is no API
key, by choice. Authentication would not prevent the actual risk anyway:
any caller, keyed or not, names the infohash, and the operator's address
is the one that joins that swarm. What auth would add is attribution and
revocation; what the shared instance actually needs is a ceiling. Hence
60 requests/minute per address, 20 candidates per request, `maxPeers` ≤ 60,
`deadlineMs` ≤ 30000, and a 60-second edge cache keyed on a hash of the
request body.

The cache costs nothing in accuracy. Swarm health moves on the order of
minutes and §4a's own `fresh` tier is two minutes wide, so a 60s cache sits
comfortably inside the window the client already treats as current.

**Two things are load-bearing and easy to undo by accident:**

- **`/v1/stream` and `/v1/play` return 501 here.** Relaying file bytes
  through a Worker would put a media stream on Cloudflare's network for
  content fetched from strangers — an AUP problem — and it makes the edge
  the bottleneck in a transfer whose whole point is that it is not. The
  measured ~2.7 MB/s streaming throughput would also clear a 100 GB/month
  egress allowance in about ten hours. Streaming is self-host only.
- **`ORIGIN_URL` must be a hostname.** A Workers subrequest to a bare IP
  literal fails with Cloudflare error 1003, so the EC2 public DNS name is
  the address that works. Give the instance an Elastic IP, or that name
  changes on every stop/start.

The origin is protected twice over: the security group admits port 8443
only from Cloudflare's published ranges, and nginx rejects any request
without the shared secret. Neither alone is sufficient — the security
group cannot tell one Cloudflare customer's Worker from another's, and a
header secret is only as private as the transport carrying it. Verified:
direct connections to `:8443` and `:8080` from outside both hang.

Deployment specifics, costs, and recovery live in
[`deploy/README.md`](deploy/README.md).

## 2. The constraint that forces this split

This is not a stylistic preference. Cloudflare Workers **cannot**
participate in BitTorrent:

| Requirement | Workers |
|---|---|
| DHT (BEP 5) — KRPC over UDP | ✗ no UDP |
| UDP trackers (BEP 15) | ✗ no UDP |
| LSD (BEP 14) — UDP multicast | ✗ no UDP, and LAN-only anyway |
| Being a peer (inbound connections) | ✗ outbound only |
| Peer wire (outbound TCP) | ✓ possible, but see below |

The `connect()` API from `cloudflare:sockets` is TCP-only, and the
documentation is explicit about direction: *"Support for handling inbound
TCP connections is coming soon. Currently, it is not possible to make an
inbound TCP connection to your Worker."*

Two consequences worth stating plainly:

- **HTTP/HTTPS trackers *could* be scraped from a Worker** via `fetch()`.
  It just doesn't help here, because the trackers that actually work in
  this ecosystem are UDP. Every tracker that returned real data when
  measured — `opentrackr:1337`, `explodie:6969`, `demonii:1337`,
  `torrent.eu.org:451` — is UDP. The one HTTPS tracker tried,
  `gbitt.info`, failed outright.
- **Relaying piece data through a Worker is off the table** regardless of
  technical feasibility: it defeats the entire P2P design and is a
  Cloudflare AUP problem. The data plane stays on the client.

## 3. What is stored, and what is deliberately not

| Stored | Not stored |
|---|---|
| `infohash → {seeders, leechers, dhtPeerCount, reports, ts}` | **Peer lists** |
| Pool of DHT routing nodes `{host, port, sources}` | Client IPs |
| | Any link between a client and an infohash |

**Why peers are excluded.** A DHT routing node is infrastructure — it is
not associated with any particular piece of content. A peer IP *is*: it
is a record of who was transferring what. Caching peer lists centrally
would make this service a log of exactly the thing the DHT's
decentralisation exists to avoid, and a natural subpoena target.

The cost of that choice is real and worth naming: clients still have to
find peers themselves. What they no longer have to do is *rank* without
help — and ranking is what gates playback (§6).

## 4. Worker API

Deployed at `https://swarmproof-control.hassen-ben-mbarek.workers.dev`.

| Route | Purpose |
|---|---|
| `GET /v1/health?ih=…&ih=…` | Batch health lookup, ≤20 hashes. Edge-cached 60s. |
| `POST /v1/health` | Report probe results. |
| `GET /v1/dht/nodes` | Up to 200 pooled nodes + the public floor. Edge-cached 60s. |
| `POST /v1/dht/nodes` | Contribute routing nodes. |
| `GET /v1/status` | Pool size, live contributions, health entry count. |
| `POST /v1/admin/aggregate` | Force a pool rebuild. Requires `ADMIN_TOKEN`; returns 404 when unset or wrong. |

Every write path validates: infohash `^[0-9a-f]{40}$`, **public IPv4
literals only** (private, loopback, link-local, CGNAT, multicast and
hostnames all rejected — hostnames because accepting names would let a
contributor smuggle in a resolvable target), ports 1–65535, ≤100 nodes
per contribution, ≤64KB bodies.

## 4a. Staleness, trust, and what a number here is worth

Swarm health is time-volatile and the reports behind it are unauthenticated.
Both facts are load-bearing, and the API is built to state them rather than
paper over them.

### Age travels with the value

Seeders come and go on the order of minutes, so a count with no age attached is
a rumour. `/v1/health` returns `ts`, `age` and a `confidence` tier per entry:
`fresh` (<= 2 min), `recent` (<= 10 min), `stale` (> 10 min). Nothing older than
`HEALTH_TTL_S` (900s) can appear at all, because KV expires it; `stale` covers
the window between the client's own re-probe threshold and that expiry, plus up
to 60s of edge caching on top.

The client honours the tier **and** re-checks the age itself. That is not
redundant: the server's clock, the edge cache and the wire all add age after the
tier was computed. The asymmetry justifies the paranoia — probing locally costs
~900ms, while acting on a stale reading promotes a dead candidate and costs a
playback stall plus a failover cycle to discover it.

Ranking also refuses partial coverage. A shared reading for one candidate
compared against a fresh probe of another is two different instruments, and the
gap between them is wider than the differences being ranked on, so the client
either answers entirely from shared health or probes everything.

### The trust model, stated plainly

**There isn't one.** Reporting is unauthenticated, there is no identity, and
nothing establishes that two reports came from two parties.

That has a direct consequence for the API surface: the stored write count is
**not published**. A field reading `reports: 15` looks exactly like fifteen
independent observers agreeing, and any reasonable caller would weight it that
way — so publishing a trust signal that is not one is worse than publishing
nothing. The counter still exists internally for operational visibility.

What limited defences exist are bounds, not proofs:

| Defence | What it actually stops |
|---|---|
| `MAX_REPORTED_COUNT` (250,000) | one report claiming ten million seeders — the previous ceiling |
| Zero-report guard | a report of all zeros cannot erase a positive reading, so a swarm cannot be declared dead by assertion |
| Per-infohash Durable Object | write amplification, not dishonesty |
| Health TTL (900s) | how long a poisoned value survives |

The residual exposure is real and worth naming: **a motivated party can inflate
the apparent health of any infohash**, and the ceiling only bounds how far in
one report. Inflation is the available attack; deflation is guarded. For the
current use — a hint that saves a ~900ms probe, with the client re-probing in
the background afterwards and re-ranking on its own measurements — the blast
radius is one wasted stream start. For any use where the number is treated as
authoritative, it is not sufficient.

A reputation layer would have to establish that reports come from distinct
parties without collecting identity, which is the same problem the node pool
solves by requiring corroboration from >= 2 distinct sources (§5). Health cannot
reuse that directly, because a health report is a measurement rather than an
address that can be independently verified by probing it. Until that is built,
treat health as advisory.

### Storage and cost economics

Infohash space is effectively unbounded and the crawler harvests ~12,800 new
hashes a minute, so anything that stores per-hash state monotonically will
outgrow its budget. Two properties keep this bounded.

**Health entries expire.** Every KV write carries `expirationTtl:
HEALTH_TTL_S` (900s), so stored health is bounded by *write rate x 15 minutes*
rather than by cumulative hashes seen. Entries for swarms that decay to zero
seeders simply age out; nothing sweeps them because nothing has to.

**The crawler does not populate KV.** Its index is local SQLite. The control
plane only ever holds infohashes some client actually asked about, which is a
far smaller and self-limiting set than everything the DHT is storing.

That distinction is the one to preserve. Wiring the crawler's output directly
into KV would invert the economics overnight: at ~12,800 hashes/min that is
~18.4M writes/day, and at Workers KV list pricing for writes that is the
dominant line item by a wide margin — the crawl rate, not the user count, would
set the bill. If crawled health is ever worth publishing, it needs a different
store (D1 or R2 with batched writes) and an explicit sampling policy, not the
per-hash KV path the request path uses.

## 5. Working within KV's limits

| Limit | Value | How the design handles it |
|---|---|---|
| Writes to the **same key** | **1/sec, both plans** | No hot key exists — see below |
| Writes to different keys | Unlimited (paid) | — |
| Value size | 25 MiB | Pool capped at 300 nodes |
| Consistency | Eventual | TTLs are minutes; staleness is measured (§7) |

The hot-key limit is the one that survives every plan tier, and a naive
"every client POSTs the shared node pool" design walks straight into it
with silently lost writes. Avoided in two steps:

1. **Contributions go to per-contributor keys** (`dht:contrib:<uuid>`,
   30-minute TTL). Distinct keys ⇒ zero contention on the write path.
2. **A cron job is the only writer of the pool key.** One writer ⇒ zero
   contention there either.

Health keys are naturally sharded by infohash, so they only contend on a
single very popular title. The original answer to that — a 120s
write-coalescing guard in the request path — **was wrong, and load
testing proved it** (§7a). It is now a Durable Object per infohash.

### Cron aggregation and Sybil resistance

Cron Triggers get 30s CPU on Workers Paid (only 10ms on free, which is
why this design requires paid). Aggregating outside the request path is
not just about CPU — it is what makes the security property possible:

> A node is ranked by the number of **distinct contributor keys** that
> reported it.

Because each client's contribution lands in its own key, one client
cannot manufacture agreement by repeating a node — verified: a node
repeated five times inside a single payload still counted as one source.
A read-modify-write design in the request path cannot distinguish
"reported twice by one client" from "reported by two clients."

Three further guards:

- **Ranking, not exclusion.** An early version *dropped* nodes below two
  sources; with few clients almost nothing corroborates, and a 5-node
  pool served 1. Single-source nodes are now kept but ranked lower. In
  production with three independent clients, 115 of 115 nodes
  corroborated, so the ordering does real work without starving the pool.
- **A public floor is always appended** — `dht.libtorrent.org:25401` and
  `dht.transmissionbt.com:6881`, the only two public bootstrap nodes
  measured alive. A fully poisoned pool still cannot strand a client.
- **Clients ping before trusting.** `bittorrent-dht` pings bootstrap
  entries, so a hostile node costs a wasted UDP packet, not a hijack.

### Zero means "not observed", not "empty"

Probe failures are asymmetric: an unreachable tracker yields `0`, not an
error the client can distinguish. This session hit exactly that — every
tracker reported `0/0` for a swarm the DHT showed had 586 peers, because
of a hex-string-vs-Buffer bug. So a report of `0` for a field never
overwrites a non-zero stored value; the entry expires on its own within
the TTL anyway.

The same applies per-field to `dhtPeerCount`, which is `0` whenever a
client answered from shared health (and so never ran a lookup) or its
1500ms DHT window closed before peers arrived — measured: Sintel returned
its first DHT peer at 430ms, Big Buck Bunny took 3378ms.

### Negative caching

`GET /v1/health` caches only *complete* answers. Caching misses for 60s
meant the first client to ask about a title pinned an empty result at the
edge, and everyone behind it got "no data" for a minute — during the
exact warm-up window when the cache should converge fastest. Observed in
testing, then fixed.

## 6. Client integration: accelerator, never dependency

`cloudCache.js` exists to enforce one rule. Every call is deadline-capped
and resolves to `null` on *any* failure — unreachable host, DNS failure,
timeout, non-200, malformed JSON. Nothing throws at the caller.

- Health read: 500ms cap
- Node read: 800ms cap
- Writes: fire-and-forget, nobody awaits them — which is why routing them
  through a Durable Object (§7a) costs the user nothing
- **Circuit breaker**: one failure stops further calls for 10s

The breaker matters more than it looks. Without it an unreachable control
plane cost the full timeout on *every* call in sequence — measured at
+1274ms over baseline. With it, the failure costs one timeout and then
gets out of the way: **+790ms**.

Two integration points in `swarmScout.js`:

**Bootstrap.** A *cold* client (no nodes on disk) briefly waits for shared
nodes, because they can go into the bootstrap array where they genuinely
reduce time-to-ready. A *warm* client never waits — local disk (~1ms)
beats an edge round trip (measured 150–196ms from this location) — so
shared nodes are folded in asynchronously instead.

This distinction is load-bearing: `bittorrent-dht` gates its `ready` event
on the bootstrap `populate()` pass, so `addNode()` after construction
enriches the routing table but does **not** improve time-to-ready.

**Ranking.** `rank()` fires the health lookup *before* awaiting the DHT.
When shared health covers every candidate it answers without touching the
DHT at all, and bootstrap continues in the background.

That is the actual win, and it is worth being precise about why. The
health cache saves a tracker scrape — measured at only 117–800ms. What it
really buys is that **the ranking decision no longer waits on discovery**,
so playback can start while discovery runs behind it. `index.js`
deliberately has no `await scout.ready()` before `rank()`; adding one
hands back the 2.5–5s the control plane exists to avoid.

## 7. Measured results

Five repetitions per scenario against the deployed Worker, median/p90 —
single runs are meaningless when DHT bootstrap alone varies 2.5–5.6s.

Seven repetitions, **scenarios interleaved** with a rotating start offset,
median and p90.

| Scenario | median | p90 | blocking wait | path |
|---|---|---|---|---|
| A. Cold client, no control plane | 911ms | 932ms | 0ms | probed |
| B. Warm client, no control plane | 935ms | 954ms | 0ms | probed |
| **C. Cold client, control plane up** | **65ms** | 79ms | 63ms | shared 7/7 |
| D. Cold client, control plane **unreachable** | 1230ms | 1240ms | 309ms | probed |
| E. Warm client, control plane up | 77ms | 188ms | 76ms | shared 7/7 |

- **A → C: 14× faster to a decision.**
- **Isolated failure cost: +309ms**, measured directly (see below).
- **Cold time to first video byte: ~2.6s**, down from ~10.4s.

### Why the failure cost is measured, not differenced

An unreachable control plane costs **+309ms**, and that figure is read off a
counter rather than inferred by subtracting one scenario from another.
Differencing cannot resolve it: DHT bootstrap variance is ±1,489ms in a good
run and ±3,605ms in a bad one, both larger than the ~300ms being measured, and
a differenced estimate once came out *negative* — causally impossible, since an
unreachable endpoint can only add work. `cloudCache.js` therefore times its own
blocking wait directly. The measured cost now cross-validates against the
scenario difference (`D − A` = +305ms) rather than contradicting it.

Scenario ordering is the other trap. Running scenarios to completion in order
warms DNS and DHT state for whatever runs later, so the harness interleaves them
and rotates the starting offset each repetition.

### The shared path needs a hit, and popular content is where hits live

The 60ms row is a cache hit. Run against an empty control plane, the first
repetitions fall back to a full probe and only reach the shared path once a
report has propagated through KV, which takes ~50s. Measured directly: with a
cold cache 2 of 7 repetitions probed; with a warm one, 7 of 7 took the shared
path.

This is a structural property, not a warm-up artefact. The control plane can
only answer for infohashes some client has already asked about, so it is fast
for popular content and silent for the long tail — and the long tail is
disproportionately what people query, because new releases and obscure titles
are exactly the things nobody has looked up yet. A deployed control plane
carrying real traffic is warm *for the popular subset*, and no amount of
traffic makes it warm for a first-of-its-kind hash.

Two consequences shape the design. The client never blocks on the control
plane beyond a hard deadline (§6), so a miss costs a bounded delay rather than
the round trip plus a probe in series. And the API reports staleness rather
than hiding it (§4a), because a confident-looking answer about a swarm that
died ten minutes ago is worse than no answer at all.

## 7a. Behaviour under load

The functional benchmark ran one client against three infohashes. That
says nothing about behaviour at scale, so a separate harness
(`tools/loadtest.mjs`) drove thousands of synthetic clients against a
staging deployment with its own KV namespace.

It found four defects. Three were in code that this document previously
described as safe.

### Write coalescing under concurrency

**The most serious.** The guard read the stored entry and wrote when the
read looked stale. That is a read-modify-write with no atomicity: under
50-way concurrency every request read "stale" at the same instant and
every request wrote.

| 2000 clients, one infohash | Before | After |
|---|---|---|
| KV writes | 48 | **1** |
| Write rate to the key | **12.6/s** (limit: 1/s) | **0.20/s** |
| HTTP 500s | 2 | **0** |

KV was rejecting the excess with `KV PUT failed: 429 Too Many Requests`,
which the catch-all turned into a 500. Fixed with a Durable Object per
infohash: DOs are single-threaded per object id, so check-then-write is
genuinely atomic and the interval is *enforced* rather than hoped for.

Cost: POST latency p50 71ms → 111ms. The client never awaits this call,
so it is invisible in the user-facing numbers (§7 re-measured after the change).

### Aggregator coverage

`list()` is lexicographic and contribution keys are
`dht:contrib:<uuid>`, so a 200-key cap starting at the beginning of the
key space scanned *the same 200 keys every run*. Later contributors were
not sampled, they were invisible — a hard 10% ceiling at 2000
contributions.

The first fix, a persisted rotating cursor, measured better but was still
wrong: a full cycle covered a deterministic **1253 of 2000** keys
(1000 + 253, then wrap), leaving 747 contributors permanently unseen.
Resuming a KV list cursor across invocations does not reliably continue
where it left off.

Replaced with a complete sweep every run, plus parallel fetches (the
original awaited each `get()` in sequence):

| | Before | Cursor attempt | Full sweep |
|---|---|---|---|
| Coverage of 2000 contributions | 200 (10%) | 1253 (63%) | **2000 (100%)** |
| Aggregate wall clock | — | 3.5s | **0.31s** |

The simpler design is both correct and faster. KV reads are I/O, not CPU,
so a few thousand parallel gets cost seconds of wall clock against a 30s
CPU budget.

### Status completeness

`GET /v1/status` read a single `list()` page, so at 2000 live
contributions it reported **947** — capped, with no indication. That is
precisely the number you would watch to decide whether the aggregator is
keeping up. Now paginated, with a `liveContributionsComplete` flag.

### KV write-to-read propagation

A health entry written through the control plane took **about 50 seconds**
to become readable at the edge, consistent with KV's documented eventual
consistency. Two consequences worth stating:

- The control plane cannot help the *first* client to ask about a title,
  and there is a warm-up lag behind every new report.
- It makes the negative-caching fix load-bearing rather than cosmetic: if
  misses were cached for 60s, that would stack on top of this window.

Health data tolerates it — measured staleness of 161s still produced no
rank inversion (§7) — but it rules out this design for anything needing
read-your-writes.

### What held up

| Dimension | Result |
|---|---|
| 5000 clients, 10,000 read requests | **1060 req/s, 0.00% errors**, p50 77–84ms, p99 196–411ms |
| 3000 distinct infohashes | 3000/3000 written and read back; distinct keys never contend |
| Validation under load | no malformed or private-IP data accepted at any concurrency |
| Sybil rule at 2000 contributors | 300/300 pooled nodes corroborated by ≥2 distinct sources |

Reproduce with `npm run loadtest -- --api <url> --admin-token <tok>
--clients 2000`. Point it at **staging**, never production — it writes
thousands of synthetic nodes and infohashes.

## 8. The crawler

The ranking layer answers "which of these candidates is healthy". It cannot
answer "what exists", because the DHT is a hash table: `get_peers` resolves
an infohash you already have, and there is no query for *the film called
Sintel*. [BEP 51][bep51] adds `sample_infohashes`, which asks a node for a
random sample of what it currently stores. Resolve those names over BEP 9
and the network indexes itself.

[bep51]: https://www.bittorrent.org/beps/bep_0051.html

### Four stages

```
find_node          →  sample_infohashes  →  get_peers      →  ut_metadata
UDP/KRPC              UDP/KRPC, BEP 51      UDP/KRPC          TCP, BEP 9
keep the node         which hashes          who has one       what is it
supply flowing        exist                 of them           called
```

Stages 1–3 run over the client's existing DHT socket. Stage 4 opens its own
short-lived TCP connection per peer and speaks the wire protocol directly —
`bittorrent-protocol` plus `ut_metadata`, never a torrent client. A client
constructs a torrent object, a piece store, a discovery loop and a swarm in
order to read a few hundred bytes of bencode, which is why an implementation
built on one manages a handful of concurrent lookups where this manages a
hundred.

**Stage 3 is the one an obvious design omits, and it governs everything
after it.** Handing a bare infohash to a torrent client asks it to
rediscover the swarm from nothing. But the node that just offered that hash
is by definition storing it, so it is the cheapest possible lead — one more
UDP round trip to an address already in hand. Measured against the
alternative on the same 60 hashes: a direct `get_peers` to the sampling node
hit 38.3% in 298ms, while a full iterative `dht.lookup()` hit 5.0% in
6,013ms and found nothing the direct method missed.

### The constraint that actually binds

`k-rpc` — the KRPC transport under `bittorrent-dht` — defaults to **16
in-flight queries for the entire socket**, and that socket is shared with
SwarmScout's own ranking lookups. Everything beyond 16 queues silently.

This is worth stating as an architectural property rather than a tuning
note, because a queued query is indistinguishable from an ignored one: the
caller's own timeout fires on a request the socket never transmitted. The
observable symptom is a crawl that stalls within ninety seconds *and stalls
sooner the more workers are added* — the signature of queueing, not of a
network limit. `swarmScout.js` now passes `concurrency: 300`. Raising it
took the stage-3 hit rate from 6.5% to ~36% and the pipeline from stalling
to steady.

### Two structures the stages share

**A peer table** (`peerTable.js`) carries address liveness across hashes. This
is bitmagnet's `ktable` reverse map in miniature, and the reusable asset is not
the peers themselves — a peer serves metadata only for torrents it holds, so a
known-good address is useless against a hash it was never associated with. What
transfers is the *address*: measured, only ~13% of the addresses the DHT hands
back accept a connection at all, the same addresses recur constantly, and
re-paying a connect timeout per hash to rediscover that dominates the naming
stage. Known-dead addresses are skipped for nothing; known-good ones are tried
first, ordered by measured connect RTT.

**Backpressure between stages 3 and 4.** The naming stage consumes roughly ten
hashes a second where the peer stage produces sixty. That imbalance is
structural — one is TCP to arbitrary internet hosts, the other a single UDP
round trip — so the boundary needs a policy. It was a bounded push that
discarded the overflow uncounted, binning 7,583 hashes that had *already been
proven to have live peers*. The producer now waits, and `stats.dropped` makes
the imbalance visible instead of silent.

### The filter is a gate, not a decoration

`contentFilter.js` sits between a successful metadata fetch and the write. A
BEP 51 crawler samples whatever the network stores, which within minutes
included material this project will not hold, so the filter runs *before*
persistence and its action is delete rather than flag: no name is written, so
no query can leak one. See the README's crawler section for the ported ruleset
and its limits.

### Privacy posture

Consistent with §3, and for the same reason. The index stores **infohashes,
names, sizes and file counts — never peer lists.** A DHT routing node is
infrastructure; a peer address is evidence of who is transferring what.
Peers are used transiently to fetch metadata and are never written down.

The crawler also never reaches the control plane. Nothing it learns is
reported to the Worker, and the Worker has no schema for it.

### What it is, honestly

Harvesting, not searching. It takes whatever drifts past its node. Coverage
accumulates over hours and days, skews toward whatever is announced most
often, and offers no guarantee that any particular title ever appears. It is
an index-building process that eventually answers queries, not a lookup that
works tonight.

## 9. What this does *not* do

Stated plainly because the headline number invites over-reading.

- **It mainly helps cold clients.** A returning client is already served
  by the local node cache, and local disk beats an edge round trip. Row E
  looks fast because shared *health* still short-circuits ranking — not
  because the shared node pool helped a warm client. It didn't.
- **It does not make streaming faster.** It makes the *decision* faster.
  Throughput, seeking and buffering are unchanged; those are data-plane
  properties.
- **It does not remove the DHT.** Peers still come from the client's own
  DHT, by deliberate privacy design (§3).
- **Its accuracy claim is narrow.** Measured on three well-seeded CC
  torrents over minutes. A swarm collapsing inside the TTL would be
  ranked on stale data; the 900s TTL bounds that, and a background probe
  always refreshes after a shared-health answer.
- **Cloudflare becomes a chokepoint.** Health metadata is far less
  sensitive than peer lists, but centralising *any* infohash lookup
  re-creates a category of exposure the DHT exists to avoid. Running this
  is a deliberate trade, not a free win.

## 10. Deferred

| Item | When it becomes worth building |
|---|---|
| **Indexer / candidate API** (Workers + D1) | When the crawler's local index (§8) outgrows SQLite and is worth sharing. Content→`[infohash]` resolution is stateless and cacheable — a natural fit. Note this is deliberately *not* a catalogue: an earlier version grew TMDb and Torznab adapters and they were removed, because "what exists" is a different question from "which swarm is alive". |
| **FTS5 over the crawled index** | When `LIKE` scanning stops being adequate. At ~220k rows it still is. |
| ~~Reusable peer table~~ | **Done.** `peerTable.js`. The honest outcome: the *skip* half carried the gain (9,946 dead connects avoided in five minutes) while the *promotion* half barely fired (629 reuses) — address reuse across hashes is rarer at this crawl rate than expected. |
| **R2 web seed** (BEP 19) | Only for content you distribute yourself. An R2 bucket behind a Worker is an HTTP web seed with native Range support; listed in `url-list`, WebTorrent consumes it natively and it guarantees a floor on availability at zero egress cost. |
| **Durable Objects WSS signaling** | Only if browser clients matter. One DO per infohash = one swarm room, with hibernation so idle swarms cost nothing. |
| ~~DO-backed health writes~~ | **Done.** Load testing showed contention was not hypothetical — see §7a. |

## 11. Operations

```bash
npm run worker:dev
```

```bash
npm run worker:deploy
```

```bash
npm run bench -- --api https://swarmproof-control.hassen-ben-mbarek.workers.dev
```

Point the client at the control plane with `SWARMPROOF_API`; unset, it is
disabled entirely and the client behaves exactly as it did before this
existed.

The admin aggregate route needs a secret:

```bash
wrangler secret put ADMIN_TOKEN --config worker/wrangler.jsonc
```

Without it that route returns 404, indistinguishable from a route that
does not exist, so a default deployment exposes no admin surface.
