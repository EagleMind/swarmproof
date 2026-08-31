'use strict'

/**
 * swarm-scout control plane load test
 * ===================================
 *
 * The functional benchmark (tools/benchmark.mjs) ran one client against
 * three infohashes. That says nothing about behaviour at scale, and this
 * design has three places where scale was assumed rather than tested:
 *
 *   1. HOT KEY. KV allows 1 write/sec to the same key on every plan. The
 *      write-coalescing guard is supposed to keep thousands of clients
 *      reporting the SAME popular title from ever contending. Untested.
 *
 *   2. CRON SCAN CEILING. The aggregator scans at most 200 contribution
 *      keys. KV list() returns keys in lexicographic order and the keys
 *      are `dht:contrib:<uuid>` — so with thousands of contributions the
 *      same lowest-UUID 200 are scanned every run and everyone else is
 *      ignored *permanently*, not merely sampled.
 *
 *   3. KEY-SPACE GROWTH. Thousands of distinct infohashes, thousands of
 *      live contribution keys, list() pagination at 1000 keys/page.
 *
 * Usage:
 *   node tools/loadtest.mjs --api <url> --admin-token <tok> [--clients 2000]
 *        [--concurrency 50] [--hashes 1000] [--only hot|cron|mixed|keyspace]
 */

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }

const API = (argOf('--api') || '').replace(/\/+$/, '')
const ADMIN = argOf('--admin-token') || ''
const CLIENTS = Number(argOf('--clients', 2000))
const CONCURRENCY = Number(argOf('--concurrency', 50))
const HASHES = Number(argOf('--hashes', 1000))
const ONLY = argOf('--only', 'all')

if (!API) { console.error('need --api <url>'); process.exit(1) }

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

const hex = n => n.toString(16).padStart(40, '0').slice(-40)
/** Deterministic synthetic infohash — valid 40-char lowercase hex. */
const fakeHash = i => hex(BigInt(i) * 0x9e3779b97f4a7c15n % (2n ** 160n))

/** Synthetic but structurally valid public IPv4s (avoids all reserved ranges). */
function fakeNode (i) {
  const a = 11 + (i % 90) // 11..100, skipping 10/x and staying below 127
  const b = (Math.floor(i / 90) % 254) + 1
  const c = (Math.floor(i / 22860) % 254) + 1
  const d = (i % 254) + 1
  return { host: `${a}.${b}.${c}.${d}`, port: 1024 + (i % 60000) }
}

function stats (samples) {
  if (!samples.length) return null
  const s = [...samples].sort((a, b) => a - b)
  const at = p => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return {
    n: s.length,
    min: s[0],
    p50: at(50),
    p90: at(90),
    p99: at(99),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  }
}

function fmt (label, st) {
  if (!st) { console.log(`  ${label.padEnd(26)} (no samples)`); return }
  console.log(
    `  ${label.padEnd(26)} n=${String(st.n).padStart(5)}  ` +
    `p50=${String(st.p50).padStart(5)}ms  p90=${String(st.p90).padStart(5)}ms  ` +
    `p99=${String(st.p99).padStart(6)}ms  max=${String(st.max).padStart(6)}ms`
  )
}

/** Bounded-concurrency worker pool. */
async function pool (total, concurrency, fn) {
  let next = 0
  const results = []
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    for (;;) {
      const i = next++
      if (i >= total) return
      results.push(await fn(i))
    }
  })
  await Promise.all(workers)
  return results
}

async function call (path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ms: Date.now() - t0, status: res.status, json }
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, error: e.name || String(e) }
  }
}

const adminHeaders = () => ({ Authorization: `Bearer ${ADMIN}` })

async function aggregate () {
  const t0 = Date.now()
  const res = await fetch(`${API}/v1/admin/aggregate`, {
    method: 'POST',
    headers: adminHeaders(),
    signal: AbortSignal.timeout(120000)
  })
  const json = await res.json().catch(() => null)
  return { ms: Date.now() - t0, status: res.status, json }
}

function tally (results) {
  const codes = {}
  for (const r of results) codes[r.error || r.status] = (codes[r.error || r.status] || 0) + 1
  return codes
}

/* ---------------------------------------------------------------- */
/* 1. hot key — thousands of clients report the SAME infohash        */
/* ---------------------------------------------------------------- */

async function testHotKey () {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`HOT KEY — ${CLIENTS} clients reporting the SAME infohash`)
  console.log(`Tests: does write-coalescing hold KV's 1-write/sec-per-key line?`)
  console.log('='.repeat(72))

  const ih = fakeHash(999999)
  const t0 = Date.now()
  const results = await pool(CLIENTS, CONCURRENCY, async i =>
    call('/v1/health', {
      method: 'POST',
      body: { reports: [{ infoHash: ih, seeders: 100 + (i % 50), leechers: 10, dhtPeerCount: 20 }] }
    })
  )
  const wall = Date.now() - t0

  let written = 0, coalesced = 0, ignoredZero = 0
  for (const r of results) {
    if (r.json) { written += r.json.written || 0; coalesced += r.json.coalesced || 0; ignoredZero += r.json.ignoredZero || 0 }
  }

  console.log(`\n  wall clock                 ${wall}ms  (${(CLIENTS / (wall / 1000)).toFixed(0)} req/s)`)
  fmt('POST /v1/health', stats(results.map(r => r.ms)))
  console.log(`  status codes               ${JSON.stringify(tally(results))}`)
  console.log(`\n  actual KV writes           ${written}`)
  console.log(`  coalesced (guard held)     ${coalesced}`)
  const rate = written / Math.max(1, wall / 1000)
  console.log(`  write rate to the key      ${rate.toFixed(2)}/s   ${rate <= 1.05 ? 'PASS (within KV 1/s)' : 'FAIL — exceeds KV 1 write/sec/key'}`)
  return { wall, written, coalesced, rate, latency: stats(results.map(r => r.ms)), codes: tally(results) }
}

/* ---------------------------------------------------------------- */
/* 2. cron ceiling — thousands of contributions                      */
/* ---------------------------------------------------------------- */

async function testCronCeiling () {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`CRON CEILING — ${CLIENTS} contributions, each with a UNIQUE marker node`)
  console.log(`Tests: does the aggregator see all contributors, or only the first 200?`)
  console.log('='.repeat(72))

  // Every client contributes 20 shared nodes plus one node unique to it.
  // Counting how many unique markers survive aggregation tells us exactly
  // how many contributors the cron actually saw.
  const t0 = Date.now()
  const results = await pool(CLIENTS, CONCURRENCY, async i => {
    const nodes = [fakeNode(500000 + i)] // unique marker
    for (let k = 0; k < 20; k++) nodes.push(fakeNode(k)) // shared, should corroborate
    return call('/v1/dht/nodes', { method: 'POST', body: { nodes } })
  })
  const wall = Date.now() - t0
  console.log(`\n  wall clock                 ${wall}ms  (${(CLIENTS / (wall / 1000)).toFixed(0)} req/s)`)
  fmt('POST /v1/dht/nodes', stats(results.map(r => r.ms)))
  console.log(`  status codes               ${JSON.stringify(tally(results))}`)

  const before = await call('/v1/status')
  console.log(`  live contributions in KV   ${before.json?.liveContributions}`)

  console.log('\n  running aggregator...')
  const agg = await aggregate()
  console.log(`  aggregate wall clock       ${agg.ms}ms  -> ${JSON.stringify(agg.json)}`)

  const st = await call('/v1/status')
  const seen = st.json?.pool?.contributions ?? 0
  console.log(`  contributions SCANNED      ${seen} of ${CLIENTS}`)
  console.log(`  pool nodes                 ${st.json?.pool?.nodes}`)
  console.log(`  corroborated               ${st.json?.pool?.corroborated}`)

  const coverage = (seen / CLIENTS) * 100
  console.log(`\n  contributor coverage       ${coverage.toFixed(1)}%  ${coverage < 95 ? '<-- most clients never counted' : 'PASS'}`)
  return { wall, sent: CLIENTS, scanned: seen, coverage, aggregateMs: agg.ms, pool: st.json?.pool, codes: tally(results) }
}

/**
 * Run the aggregator twice over a stable key set and check whether the
 * SAME contributions get scanned both times. If list() order is stable
 * and the scan is capped, later contributors are not merely sampled —
 * they are excluded forever.
 */
async function testCronFairness () {
  console.log(`\n${'='.repeat(72)}`)
  console.log('CRON FAIRNESS — is exclusion permanent or does it rotate?')
  console.log('='.repeat(72))

  const a = await aggregate()
  const poolA = (await call('/v1/status')).json?.pool
  const nodesA = (await call('/v1/dht/nodes')).json?.nodes?.map(n => `${n.host}:${n.port}`) || []

  const b = await aggregate()
  const poolB = (await call('/v1/status')).json?.pool
  // Edge cache can serve a stale pool; compare via status counts too.
  const nodesB = (await call('/v1/dht/nodes')).json?.nodes?.map(n => `${n.host}:${n.port}`) || []

  const setA = new Set(nodesA)
  const overlap = nodesB.filter(n => setA.has(n)).length
  const pct = nodesB.length ? (overlap / nodesB.length) * 100 : 0

  console.log(`  run 1: scanned=${poolA?.contributions} nodes=${poolA?.nodes} (${a.ms}ms)`)
  console.log(`  run 2: scanned=${poolB?.contributions} nodes=${poolB?.nodes} (${b.ms}ms)`)
  console.log(`  served-node overlap between runs: ${pct.toFixed(1)}%`)
  console.log(`  ${pct > 95 ? '<-- identical set: exclusion is PERMANENT, not sampling' : 'set rotates between runs'}`)
  return { overlapPct: pct, runA: poolA, runB: poolB }
}

/* ---------------------------------------------------------------- */
/* 3. key-space — thousands of distinct infohashes                   */
/* ---------------------------------------------------------------- */

async function testKeyspace () {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`KEY SPACE — ${HASHES} distinct infohashes`)
  console.log('Tests: per-key sharding, batch reads, and status list() at scale')
  console.log('='.repeat(72))

  const batches = Math.ceil(HASHES / 20) // MAX_HASHES_PER_QUERY
  const t0 = Date.now()
  const writes = await pool(batches, CONCURRENCY, async b => {
    const reports = []
    for (let k = 0; k < 20; k++) {
      const idx = b * 20 + k
      if (idx >= HASHES) break
      reports.push({ infoHash: fakeHash(idx), seeders: (idx % 400) + 1, leechers: idx % 40, dhtPeerCount: idx % 100 })
    }
    return call('/v1/health', { method: 'POST', body: { reports } })
  })
  const writeWall = Date.now() - t0
  console.log(`\n  wrote ${HASHES} keys in ${batches} batches, ${writeWall}ms (${(HASHES / (writeWall / 1000)).toFixed(0)} keys/s)`)
  fmt('POST /v1/health (batch 20)', stats(writes.map(r => r.ms)))
  console.log(`  status codes               ${JSON.stringify(tally(writes))}`)

  const t1 = Date.now()
  const reads = await pool(batches, CONCURRENCY, async b => {
    const qs = []
    for (let k = 0; k < 20; k++) {
      const idx = b * 20 + k
      if (idx >= HASHES) break
      qs.push(`ih=${fakeHash(idx)}`)
    }
    return call(`/v1/health?${qs.join('&')}`)
  })
  const readWall = Date.now() - t1

  let found = 0, asked = 0
  for (const r of reads) {
    if (r.json?.health) { found += Object.keys(r.json.health).length }
  }
  asked = HASHES

  console.log(`\n  read back in ${readWall}ms (${(HASHES / (readWall / 1000)).toFixed(0)} keys/s)`)
  fmt('GET /v1/health (batch 20)', stats(reads.map(r => r.ms)))
  console.log(`  hydrated                   ${found}/${asked}  ${found === asked ? 'PASS' : '<-- missing keys'}`)
  console.log(`  status codes               ${JSON.stringify(tally(reads))}`)

  const st = await call('/v1/status')
  console.log(`\n  GET /v1/status             ${st.ms}ms -> healthEntries=${st.json?.healthEntries}`)
  if (st.ms > 3000) console.log('  <-- status list() is getting slow at this key count')

  return { hashes: HASHES, writeWall, readWall, found, asked, statusMs: st.ms, write: stats(writes.map(r => r.ms)), read: stats(reads.map(r => r.ms)) }
}

/* ---------------------------------------------------------------- */
/* 4. mixed read load — the realistic steady state                   */
/* ---------------------------------------------------------------- */

async function testMixedReads () {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`MIXED READ LOAD — ${CLIENTS} clients doing a real cold-start sequence`)
  console.log('Tests: the edge-cached read path, which is what most traffic is')
  console.log('='.repeat(72))

  const t0 = Date.now()
  const results = await pool(CLIENTS, CONCURRENCY, async i => {
    const nodes = await call('/v1/dht/nodes')
    const qs = [0, 1, 2].map(k => `ih=${fakeHash((i + k) % Math.max(1, HASHES))}`).join('&')
    const health = await call(`/v1/health?${qs}`)
    return { nodes, health }
  })
  const wall = Date.now() - t0

  const nodeMs = results.map(r => r.nodes.ms)
  const healthMs = results.map(r => r.health.ms)
  const all = [...results.map(r => r.nodes), ...results.map(r => r.health)]

  console.log(`\n  wall clock                 ${wall}ms  (${((CLIENTS * 2) / (wall / 1000)).toFixed(0)} req/s across ${CLIENTS * 2} requests)`)
  fmt('GET /v1/dht/nodes', stats(nodeMs))
  fmt('GET /v1/health', stats(healthMs))
  console.log(`  status codes               ${JSON.stringify(tally(all))}`)

  const errs = all.filter(r => r.status !== 200).length
  console.log(`  error rate                 ${((errs / all.length) * 100).toFixed(2)}%  ${errs === 0 ? 'PASS' : ''}`)
  return { wall, nodes: stats(nodeMs), health: stats(healthMs), errors: errs, total: all.length }
}

/* ---------------------------------------------------------------- */

async function main () {
  console.log('swarm-scout control plane — LOAD TEST')
  console.log('='.repeat(72))
  console.log(`target      : ${API}`)
  console.log(`clients     : ${CLIENTS}`)
  console.log(`concurrency : ${CONCURRENCY}`)
  console.log(`infohashes  : ${HASHES}`)

  const out = { api: API, clients: CLIENTS, concurrency: CONCURRENCY, hashes: HASHES, ts: Date.now() }

  if (ONLY === 'all' || ONLY === 'hot') out.hotKey = await testHotKey()
  if (ONLY === 'all' || ONLY === 'keyspace') out.keyspace = await testKeyspace()
  if (ONLY === 'all' || ONLY === 'cron') {
    out.cron = await testCronCeiling()
    out.fairness = await testCronFairness()
  }
  if (ONLY === 'all' || ONLY === 'mixed') out.mixed = await testMixedReads()

  const fs = await import('fs')
  fs.writeFileSync('loadtest-results.json', JSON.stringify(out, null, 2))
  console.log('\nwrote loadtest-results.json')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
