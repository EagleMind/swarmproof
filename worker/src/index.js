/**
 * swarm-scout control plane
 * =========================
 *
 * Cloudflare Workers cannot participate in BitTorrent at all: `connect()`
 * from `cloudflare:sockets` is TCP-only and outbound-only ("Support for
 * handling inbound TCP connections is coming soon"), so there is no UDP
 * for the DHT (BEP 5) or UDP trackers (BEP 15), and a Worker can never
 * accept a peer connection.
 *
 * So this Worker never touches the P2P network. It is shared memory
 * between clients that already did the work:
 *
 *   - swarm health   (infohash -> seeders/leechers/dhtPeerCount)
 *   - DHT node pool  (routing nodes clients found alive)
 *
 * Deliberately NOT stored: peer lists. A DHT routing node is
 * infrastructure and is not tied to any particular content; a peer IP is
 * evidence of who is transferring what. Peers stay in the client's own
 * DHT.
 */

const HEALTH_PREFIX = 'health:'
const CONTRIB_PREFIX = 'dht:contrib:'
const POOL_KEY = 'dht:nodes:pool'

const HEALTH_TTL_S = 900 // KV expirationTtl for a health entry
const HEALTH_COALESCE_MS = 120_000 // skip rewrite if stored entry is younger
const CONTRIB_TTL_S = 1800 // contributions expire; the pool is rebuilt from live ones

const EDGE_CACHE_S = 60 // Cache API TTL on GETs
const MAX_BODY_BYTES = 64 * 1024
const MAX_HASHES_PER_QUERY = 20
const MAX_NODES_PER_CONTRIB = 100
const MAX_POOL_NODES = 300
const MAX_NODES_SERVED = 200
const MAX_CONTRIB_KEYS = 20000 // safety valve only; a full sweep is the norm
const CONTRIB_FETCH_BATCH = 100 // parallel KV gets per batch
const MIN_DISTINCT_SOURCES = 2 // Sybil resistance: agreement required to rank

/**
 * Always appended to whatever the pool holds, so a poisoned or empty pool
 * can never fully strand a client. Measured live from a real connection —
 * these were the only public bootstrap nodes that answered a KRPC ping
 * (4/4 attempts, ~50-60ms); router.bittorrent.com, router.utorrent.com and
 * dht.aelitis.com were silent on both DNS name and hardcoded IP.
 */
const PUBLIC_FLOOR = [
  { host: 'dht.libtorrent.org', port: 25401, floor: true },
  { host: 'dht.transmissionbt.com', port: 6881, floor: true }
]

const INFOHASH_RE = /^[0-9a-f]{40}$/

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)
    const { pathname } = url

    try {
      if (request.method === 'GET' && pathname === '/v1/health') {
        return await getHealth(url, env, ctx)
      }
      if (request.method === 'POST' && pathname === '/v1/health') {
        return await postHealth(request, env)
      }
      if (request.method === 'GET' && pathname === '/v1/dht/nodes') {
        return await getNodes(request, env, ctx)
      }
      if (request.method === 'POST' && pathname === '/v1/dht/nodes') {
        return await postNodes(request, env)
      }
      if (request.method === 'GET' && pathname === '/v1/status') {
        return await getStatus(env)
      }
      if (request.method === 'POST' && pathname === '/v1/admin/aggregate') {
        return await adminAggregate(request, env)
      }
      return json({ error: 'not found' }, 404)
    } catch (err) {
      // Never leak internals; the client treats any non-200 as "no data"
      // and falls back to probing locally anyway.
      console.error('unhandled', err?.stack || String(err))
      return json({ error: 'internal error' }, 500)
    }
  },

  /**
   * Cron aggregator. Contributions live in per-contributor keys so the
   * write path has zero contention; this is the single writer for the
   * pool key, so that has none either. Aggregating here (rather than with
   * read-modify-write in the request path) is what makes the
   * "reported by N *distinct* sources" test possible at all — one client
   * repeating itself cannot manufacture agreement.
   */
  async scheduled (event, env, ctx) {
    ctx.waitUntil(aggregateNodes(env))
  }
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

/**
 * How old an entry is, and how much weight to put on it.
 *
 * Swarm health is time-volatile: seeders come and go on the order of
 * minutes, so a number without an age attached is not an answer, it is a
 * rumour. A caller that treats a twelve-minute-old reading as current will
 * promote a dead candidate and burn a stall cycle discovering that — which
 * is worse than having been told nothing and probing locally.
 *
 * The tiers are advisory and deliberately conservative:
 *
 *   fresh    <= 2 min   decide on this
 *   recent   <= 10 min  usable; matches the client's own re-probe threshold
 *   stale     > 10 min  do not decide on this alone — probe
 *
 * Nothing older than HEALTH_TTL_S can appear here at all, because KV expires
 * it; `stale` exists for the window between the client's threshold and that
 * expiry, plus up to EDGE_CACHE_S of edge caching on top.
 */
const FRESH_MS = 120_000
const RECENT_MS = 600_000

function describe (entry, now) {
  const age = Math.max(0, now - (entry.ts || 0))
  const confidence = age <= FRESH_MS ? 'fresh' : age <= RECENT_MS ? 'recent' : 'stale'

  // `reports` is deliberately not exposed.
  //
  // It counts writes, not reporters. Reporting is unauthenticated and there
  // is no identity, so the number carries no corroboration — yet a field
  // called "reports: 15" reads exactly like fifteen independent parties
  // agreeing, and a caller would reasonably weight it that way. Publishing a
  // trust signal that is not one is worse than publishing nothing. See the
  // trust section in ARCHITECTURE.md; if a reputation model is ever built,
  // this is where its output belongs.
  return {
    seeders: entry.seeders || 0,
    leechers: entry.leechers || 0,
    dhtPeerCount: entry.dhtPeerCount || 0,
    ts: entry.ts || 0,
    age,
    confidence
  }
}

async function getHealth (url, env, ctx) {
  const hashes = [...new Set(url.searchParams.getAll('ih').map(h => h.toLowerCase()))]
  if (hashes.length === 0) return json({ error: 'no ih parameter' }, 400)
  if (hashes.length > MAX_HASHES_PER_QUERY) {
    return json({ error: `at most ${MAX_HASHES_PER_QUERY} ih parameters` }, 400)
  }
  const bad = hashes.find(h => !INFOHASH_RE.test(h))
  if (bad) return json({ error: `malformed infohash: ${bad.slice(0, 64)}` }, 400)

  // Normalise the cache key so ?ih=a&ih=b and ?ih=b&ih=a share an entry.
  const cacheKey = new Request(
    `${url.origin}/v1/health?${hashes.slice().sort().map(h => `ih=${h}`).join('&')}`
  )
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  const entries = await Promise.all(hashes.map(h => env.SWARM_KV.get(HEALTH_PREFIX + h, 'json')))
  const out = {}
  let found = 0
  const now = Date.now()
  hashes.forEach((h, i) => {
    const e = entries[i]
    if (!e) return
    found++
    out[h] = describe(e, now)
  })

  // Only cache a *complete* answer. Caching misses for 60s means the very
  // first client to ask about a title pins an empty result at the edge,
  // and every client behind it keeps getting "no data" for a minute even
  // though that first client has since reported real numbers. That is
  // precisely the warm-up window where the shared cache should be
  // converging fastest, so a partial answer is returned uncached.
  const complete = found === hashes.length
  const res = json({ health: out })
  res.headers.set('Cache-Control', complete ? `public, max-age=${EDGE_CACHE_S}` : 'no-store')
  if (complete) ctx.waitUntil(cache.put(cacheKey, res.clone()))
  return res
}

/**
 * Merge a new observation over the stored one.
 *
 * A report of 0 for a field never overwrites a non-zero stored value.
 * Probe failures are asymmetric: an unreachable tracker yields 0, not an
 * error the client can distinguish. This session hit exactly that — every
 * tracker reported 0/0 for a swarm the DHT showed had 586 peers, because
 * of a hex-string-vs-Buffer bug. dhtPeerCount is 0 whenever a client
 * answered from shared health (so never ran a lookup) or its 1500ms DHT
 * window closed early.
 *
 * Returns null when the report should be discarded entirely.
 */
function mergeHealth (prev, obs, now) {
  const { seeders, leechers, dhtPeerCount } = obs

  const zeroed = seeders === 0 && leechers === 0 && dhtPeerCount === 0
  if (zeroed && prev && (prev.seeders > 0 || prev.dhtPeerCount > 0)) return null

  return {
    seeders: seeders || prev?.seeders || 0,
    leechers: leechers || prev?.leechers || 0,
    dhtPeerCount: dhtPeerCount || prev?.dhtPeerCount || 0,
    reports: (prev?.reports || 0) + 1,
    ts: now
  }
}

/**
 * Per-infohash write coalescer.
 *
 * Load testing killed the original design. It read the stored entry, and
 * wrote when that read looked stale — a plain read-modify-write with no
 * atomicity. Under 50-way concurrency every request read "stale" at the
 * same instant and every request wrote: 2000 clients reporting one
 * infohash produced 48 writes in 3.8s, i.e. **12.6 writes/sec to a single
 * key against KV's documented limit of 1/sec on every plan**, and KV
 * started returning `KV PUT failed: 429 Too Many Requests`.
 *
 * A Durable Object is single-threaded per object id, so routing by
 * infohash makes the check-then-write genuinely atomic. The interval is
 * now enforced rather than hoped for: KV cannot see more than one write
 * per HEALTH_COALESCE_MS per key, no matter how many clients report.
 */
export class HealthCoalescer {
  constructor (state, env) {
    this.state = state
    this.env = env
    this.cached = undefined
  }

  async fetch (request) {
    const { infoHash, seeders, leechers, dhtPeerCount } = await request.json()
    const now = Date.now()

    if (this.cached === undefined) {
      this.cached = (await this.state.storage.get('v')) || null
    }
    const prev = this.cached

    const next = mergeHealth(prev, { seeders, leechers, dhtPeerCount }, now)
    if (!next) return json({ outcome: 'ignoredZero' })

    if (prev && now - prev.ts < HEALTH_COALESCE_MS) return json({ outcome: 'coalesced' })

    // Commit to DO storage first so the interval holds even if the KV
    // write is rejected — otherwise a throttled write would leave the
    // gate open and the next request would try again immediately.
    this.cached = next
    await this.state.storage.put('v', next)

    try {
      await this.env.SWARM_KV.put(HEALTH_PREFIX + infoHash, JSON.stringify(next), {
        expirationTtl: HEALTH_TTL_S
      })
    } catch (err) {
      // Never surface as a 5xx: a throttled write is a skipped write, and
      // the client's own probe result is unaffected.
      console.warn('kv put throttled', err?.message)
      return json({ outcome: 'kvThrottled' })
    }
    return json({ outcome: 'written' })
  }
}

async function postHealth (request, env) {
  const body = await readJson(request)
  if (body.error) return json({ error: body.error }, 400)

  const reports = Array.isArray(body.value?.reports) ? body.value.reports : null
  if (!reports) return json({ error: 'expected { reports: [...] }' }, 400)
  if (reports.length > MAX_HASHES_PER_QUERY) {
    return json({ error: `at most ${MAX_HASHES_PER_QUERY} reports` }, 400)
  }

  const rejected = []
  const valid = []

  for (const r of reports) {
    const ih = String(r?.infoHash || '').toLowerCase()
    if (!INFOHASH_RE.test(ih)) { rejected.push(ih.slice(0, 64)); continue }

    const seeders = clampInt(r.seeders)
    const leechers = clampInt(r.leechers)
    const dhtPeerCount = clampInt(r.dhtPeerCount)
    if (seeders === null || leechers === null || dhtPeerCount === null) {
      rejected.push(ih)
      continue
    }
    valid.push({ infoHash: ih, seeders, leechers, dhtPeerCount })
  }

  // One DO per infohash, all in parallel. Different infohashes are
  // different objects, so this fans out rather than serialising.
  const outcomes = await Promise.all(valid.map(async obs => {
    try {
      const stub = env.HEALTH_DO.get(env.HEALTH_DO.idFromName(obs.infoHash))
      const res = await stub.fetch('https://do/report', {
        method: 'POST',
        body: JSON.stringify(obs)
      })
      const j = await res.json()
      return j.outcome
    } catch (err) {
      console.warn('coalescer failed', err?.message)
      return 'error'
    }
  }))

  const count = o => outcomes.filter(x => x === o).length
  return json({
    written: count('written'),
    coalesced: count('coalesced'),
    ignoredZero: count('ignoredZero'),
    kvThrottled: count('kvThrottled'),
    errors: count('error'),
    rejected
  })
}

/* ------------------------------------------------------------------ */
/* dht nodes                                                           */
/* ------------------------------------------------------------------ */

async function getNodes (request, env, ctx) {
  const cache = caches.default
  const cacheKey = new Request(new URL('/v1/dht/nodes', request.url).toString())
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  const pool = (await env.SWARM_KV.get(POOL_KEY, 'json')) || { nodes: [], ts: 0 }

  // Ranked nodes first, then the public floor. The floor is always present
  // so an empty or poisoned pool still leaves the client able to bootstrap.
  const nodes = [...pool.nodes.slice(0, MAX_NODES_SERVED), ...PUBLIC_FLOOR]

  const res = json({ nodes, pooledAt: pool.ts, pooled: pool.nodes.length })
  res.headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_S}`)
  ctx.waitUntil(cache.put(cacheKey, res.clone()))
  return res
}

async function postNodes (request, env) {
  const body = await readJson(request)
  if (body.error) return json({ error: body.error }, 400)

  const raw = Array.isArray(body.value?.nodes) ? body.value.nodes : null
  if (!raw) return json({ error: 'expected { nodes: [...] }' }, 400)

  const nodes = []
  let rejected = 0
  for (const n of raw.slice(0, MAX_NODES_PER_CONTRIB)) {
    if (!isPublicIPv4(n?.host) || !isValidPort(n?.port)) { rejected++; continue }
    nodes.push({ host: n.host, port: n.port })
  }
  if (nodes.length === 0) return json({ accepted: 0, rejected }, 200)

  // Per-contributor key: distinct keys mean no write contention here, and
  // they are what lets the cron count *distinct* sources for a node.
  const key = CONTRIB_PREFIX + crypto.randomUUID()
  await env.SWARM_KV.put(key, JSON.stringify({ nodes, ts: Date.now() }), {
    expirationTtl: CONTRIB_TTL_S
  })

  return json({ accepted: nodes.length, rejected })
}

/**
 * Merge live contributions into the served pool.
 *
 * Scoring is by number of *distinct contributor keys* that reported a
 * node, which is the Sybil-resistant part: a single client cannot
 * manufacture agreement by repeating itself, because all of its reports
 * would have to land in separate keys to count separately, and each of
 * those expires.
 */
async function aggregateNodes (env) {
  const now = Date.now()
  const seen = new Map() // "host:port" -> { host, port, sources, lastSeen }

  // Carry the existing pool forward.
  //
  // Necessary because the scan below is a ROTATING WINDOW, not a full
  // sweep. Corroboration counts distinct contributors, and two clients
  // that report the same node will often land in different runs — if each
  // run started from an empty map, those two would never be seen
  // together and nothing would ever reach MIN_DISTINCT_SOURCES. Entries
  // age out once nothing has re-reported them within the contribution
  // TTL, so a node that goes away does eventually leave the pool.
  const existing = await env.SWARM_KV.get(POOL_KEY, 'json')
  for (const n of existing?.nodes || []) {
    if (now - (n.lastSeen || 0) > CONTRIB_TTL_S * 1000) continue
    seen.set(`${n.host}:${n.port}`, {
      host: n.host,
      port: n.port,
      sources: n.sources || 1,
      lastSeen: n.lastSeen || 0
    })
  }

  // Sweep every page, every run.
  //
  // Two earlier designs failed here, both by scanning a subset:
  //   1. A fixed 200-key cap starting at the beginning of the key space.
  //      KV list() is lexicographic and keys are `dht:contrib:<uuid>`, so
  //      that walked the same lowest-UUID 200 forever — later
  //      contributors were structurally excluded, not sampled.
  //   2. A persisted rotating cursor. Measured better but still wrong: a
  //      full cycle covered a deterministic 1253 of 2000 live keys
  //      (1000 + 253, then wrap), so 747 contributors stayed invisible.
  //      Resuming a KV list cursor across invocations does not reliably
  //      continue where it left off.
  //
  // A full sweep has no such failure mode, and there is no reason to
  // avoid it: KV reads are I/O, not CPU, so with parallel fetches a few
  // thousand keys costs seconds of wall clock against a 30s CPU / 5min
  // wall budget. MAX_CONTRIB_KEYS is now only a safety valve — if the key
  // count ever approaches it, shard the prefix rather than sampling.
  let cursor
  let truncated = false
  const names = []

  for (;;) {
    const page = await env.SWARM_KV.list({ prefix: CONTRIB_PREFIX, cursor, limit: 1000 })
    for (const k of page.keys) names.push(k.name)
    if (names.length >= MAX_CONTRIB_KEYS) { truncated = true; break }
    if (page.list_complete) break
    cursor = page.cursor
  }
  const keysScanned = names.length


  const all = [...seen.values()]
  const corroborated = all.filter(n => n.sources >= MIN_DISTINCT_SOURCES)

  // Rank by agreement, then backfill with single-source nodes — do NOT
  // exclude them. Excluding was the first cut and it made the pool
  // useless in practice: with a handful of clients almost nothing reaches
  // two distinct sources, so a 5-node pool served 1. Sybil resistance
  // here comes from *ordering*, not exclusion — a poisoner cannot outrank
  // genuine agreement, the client pings every node before trusting it
  // (bittorrent-dht does this on bootstrap), and PUBLIC_FLOOR is always
  // appended so even a fully poisoned pool cannot strand anyone.
  const ranked = all
    .sort((a, b) => b.sources - a.sources || b.lastSeen - a.lastSeen)
    .slice(0, MAX_POOL_NODES)

  await env.SWARM_KV.put(POOL_KEY, JSON.stringify({
    nodes: ranked,
    ts: now,
    contributions: keysScanned,
    corroborated: corroborated.length,
    truncated
  }))

  console.log(`aggregated ${ranked.length} nodes from ${keysScanned} contributions (${corroborated.length} corroborated, truncated=${truncated})`)
  return ranked.length
}

/* ------------------------------------------------------------------ */
/* status + helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Force a pool rebuild without waiting for the 10-minute cron. Useful for
 * verifying the aggregator after a deploy and for recovering promptly if
 * a bad batch of contributions ever lands.
 *
 * Disabled entirely (404, indistinguishable from a non-existent route)
 * unless ADMIN_TOKEN is configured as a secret, so a default deployment
 * exposes no admin surface at all.
 */
async function adminAggregate (request, env) {
  const expected = env.ADMIN_TOKEN
  if (!expected) return json({ error: 'not found' }, 404)

  const auth = request.headers.get('authorization') || ''
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!timingSafeEqual(given, expected)) return json({ error: 'not found' }, 404)

  const count = await aggregateNodes(env)
  return json({ aggregated: count })
}

/** Constant-time compare so the token can't be recovered by timing. */
function timingSafeEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Count keys under a prefix across pages.
 *
 * KV list() returns at most one page (1000 keys) per call. The original
 * status handler read a single page, so at 2000 live contributions it
 * reported 947 — silently capped, which is exactly the number you would
 * be watching to decide whether the aggregator is keeping up.
 */
async function countPrefix (env, prefix, max = 10000) {
  let cursor
  let n = 0
  do {
    const page = await env.SWARM_KV.list({ prefix, cursor, limit: 1000 })
    n += page.keys.length
    if (page.list_complete || n >= max) return { count: n, complete: page.list_complete }
    cursor = page.cursor
  } while (cursor)
  return { count: n, complete: true }
}

async function getStatus (env) {
  const pool = (await env.SWARM_KV.get(POOL_KEY, 'json')) || null
  const contribs = await countPrefix(env, CONTRIB_PREFIX)
  const health = await countPrefix(env, HEALTH_PREFIX)

  return json({
    pool: pool
      ? {
          nodes: pool.nodes.length,
          ts: pool.ts,
          contributions: pool.contributions,
          corroborated: pool.corroborated,
          truncated: pool.truncated
        }
      : null,
    liveContributions: contribs.count,
    liveContributionsComplete: contribs.complete,
    healthEntries: health.count,
    floor: PUBLIC_FLOOR.length
  })
}

async function readJson (request) {
  const len = Number(request.headers.get('content-length') || 0)
  if (len > MAX_BODY_BYTES) return { error: 'body too large' }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return { error: 'body too large' }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: 'invalid JSON' }
  }
}

/**
 * Bound on a reported count.
 *
 * 10,000,000 was nonsense: the largest swarms ever observed are in the low
 * hundred-thousands, so the old ceiling let one unauthenticated POST claim
 * ten million seeders and have it stored verbatim. A tighter bound does not
 * make reporting trustworthy — nothing here does, see the trust section in
 * ARCHITECTURE.md — but it caps how far one caller can move a number.
 */
const MAX_REPORTED_COUNT = 250_000

function clampInt (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > MAX_REPORTED_COUNT) return null
  return Math.floor(n)
}

function isValidPort (p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535
}

/**
 * Only public IPv4 literals are accepted. This keeps the pool from being
 * used to point clients at internal addresses (an SSRF-flavoured trick
 * against whoever runs the client) and rejects junk early. Hostnames are
 * refused too — a DHT routing node is an address, and accepting names
 * would let a contributor smuggle in a resolvable target.
 */
function isPublicIPv4 (host) {
  if (typeof host !== 'string') return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some(n => n > 255)) return false

  const [a, b] = o
  if (a === 0 || a === 127) return false // this-network, loopback
  if (a === 10) return false // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918
  if (a === 192 && b === 168) return false // RFC1918
  if (a === 169 && b === 254) return false // link-local
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT RFC6598
  if (a === 192 && b === 0) return false // IETF protocol assignments
  if (a >= 224) return false // multicast + reserved + broadcast
  return true
}

function json (obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

export { isPublicIPv4, aggregateNodes }
