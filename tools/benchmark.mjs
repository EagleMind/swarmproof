'use strict'

/**
 * swarm-scout benchmark
 * =====================
 *
 * Measures what the Cloudflare control plane actually buys, and — just as
 * importantly — where it buys nothing.
 *
 * Two things are measured:
 *
 *  1. LATENCY, as time-to-decision: from "I have candidate infohashes" to
 *     "I know which swarm to stream from". That is the number a user
 *     feels before playback can start.
 *
 *  2. ACCURACY, as rank-inversion rate: how often a decision made from
 *     shared health disagrees with one made from a fresh local probe.
 *     This is the metric that decides whether the cache is trustworthy at
 *     all. Being off by 10 seeders does not matter; picking the wrong
 *     swarm does.
 *
 * Every scenario is run N times and reported as median and p90, because
 * DHT bootstrap alone was measured varying between 2.5s and 5.6s — a
 * single run of any of these means nothing.
 *
 * Usage:
 *   node tools/benchmark.mjs --api https://your-worker.workers.dev [--reps 5] [--tfb]
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import PeerCache from '../peerCache.js'
import CloudCache from '../cloudCache.js'
import SwarmScout from '../swarmScout.js'
import StreamServer from '../streamServer.js'

// Never inherit an ambient endpoint: scenarios must control this exactly.
delete process.env.SWARM_SCOUT_API

const args = process.argv.slice(2)
const API = argOf('--api') || ''
const REPS = Number(argOf('--reps') || 5)
const DO_TFB = args.includes('--tfb')

function argOf (name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce'
]

const candidate = (label, infoHash) => ({
  label,
  infoHash,
  trackers: TRACKERS,
  magnetURI: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(label)}` +
    TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')
})

// Blender Foundation open movies (CC-BY) — freely redistributable.
const CANDIDATES = [
  candidate('Sintel', '08ada5a7a6183aae1e09d831df6748d566095a10'),
  candidate('Big Buck Bunny', 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'),
  candidate('Cosmos Laundromat', 'c9e15763f722f23e98a29decdfae341b98d53056')
]

const TMP = path.join(os.tmpdir(), 'swarm-scout-bench')
fs.mkdirSync(TMP, { recursive: true })
// `.db`, not `.json`. PeerCache moved to SQLite; this helper kept handing it
// a path left over from the JSON era, so any scenario that reused a warm
// cache file opened a JSON document as a database and died with
// "file is not a database". The scenario timings never hit it — they delete
// the file first and SQLite happily creates a new one under any extension —
// so only the accuracy harness, which reads an existing cache, ever failed.
const cacheFile = name => path.join(TMP, `${name}.db`)

/* ------------------------------------------------------------------ */

async function decide ({ name, cold, endpoint }) {
  const file = cacheFile(name)
  if (cold) { try { fs.rmSync(file, { force: true }) } catch {} }

  const cache = new PeerCache({ file })
  const cloud = new CloudCache({ endpoint })

  const t0 = Date.now()
  const scout = await SwarmScout.create({ cache, cloud })
  const ranked = await scout.rank(CANDIDATES)
  const ms = Date.now() - t0

  const winner = ranked[0]
  const result = {
    ms,
    // Time the caller actually blocked on the control plane, measured
    // inside CloudCache. This is the real cost on the critical path;
    // differencing two scenarios cannot recover it, because DHT bootstrap
    // variance is ~10x larger than the quantity being measured.
    cloudWaitMs: cloud.stats.waitMs,
    cloudCalls: cloud.stats.calls,
    winner: winner?.label,
    source: winner?.source,
    score: winner?.score,
    ranking: ranked.map(r => r.label)
  }

  // destroy() flushes nodes; give the fire-and-forget report a moment so
  // later scenarios see a populated pool rather than racing it.
  scout.destroy()
  await sleep(150)
  return result
}

/**
 * Does a decision taken from shared health match one taken from a fresh
 * probe? Latency is worthless if the answer is wrong.
 */
async function accuracy () {
  console.log('\n\n=== ACCURACY: shared health vs fresh local probe ===')
  if (!API) { console.log('(skipped — no --api)'); return null }

  const cloud = new CloudCache({ endpoint: API })
  const shared = await cloud.getHealth(CANDIDATES.map(c => c.infoHash))
  if (!shared || Object.keys(shared).length === 0) {
    console.log('(skipped — control plane has no health data yet)')
    return null
  }

  // Fresh, fully-probed ground truth.
  const cache = new PeerCache({ file: cacheFile('accuracy') })
  const scout = await SwarmScout.create({ cache, cloud: new CloudCache({ endpoint: '' }) })
  await scout.ready()
  const probed = await scout.rank(CANDIDATES, { sharedFirst: false })
  scout.destroy()

  console.log('\n  candidate            shared(s/l)     probed(s/l)     seeder err')
  const rows = []
  for (const p of probed) {
    const e = shared[p.infoHash.toLowerCase()]
    if (!e) continue
    const err = Math.abs(e.seeders - p.sources.seeders)
    const pct = p.sources.seeders ? (err / p.sources.seeders) * 100 : (e.seeders ? 100 : 0)
    rows.push({ label: p.label, sharedS: e.seeders, probedS: p.sources.seeders, err, pct, ageMs: Date.now() - e.ts })
    console.log(`  ${p.label.padEnd(20)} ${String(e.seeders).padStart(5)}/${String(e.leechers).padEnd(5)}   ${String(p.sources.seeders).padStart(5)}/${String(p.sources.leechers).padEnd(5)}   ${String(err).padStart(4)} (${pct.toFixed(1)}%)`)
  }

  // The metric that actually matters: same winner, same order?
  const sharedRank = [...rows].sort((a, b) => b.sharedS - a.sharedS).map(r => r.label)
  const probedRank = [...rows].sort((a, b) => b.probedS - a.probedS).map(r => r.label)
  const sameWinner = sharedRank[0] === probedRank[0]
  const sameOrder = sharedRank.join('|') === probedRank.join('|')

  console.log(`\n  shared order : ${sharedRank.join(' > ')}`)
  console.log(`  probed order : ${probedRank.join(' > ')}`)
  console.log(`  same winner  : ${sameWinner ? 'YES' : 'NO  <-- rank inversion'}`)
  console.log(`  same order   : ${sameOrder ? 'YES' : 'NO'}`)
  console.log(`  staleness    : ${Math.round(Math.max(...rows.map(r => r.ageMs)) / 1000)}s max`)

  return { rows, sameWinner, sameOrder, sharedRank, probedRank }
}

/** Time to first playable byte, end to end. Heavy, so opt-in. */
async function timeToFirstByte (endpoint) {
  console.log('\n\n=== TIME TO FIRST PLAYABLE BYTE ===')
  const cache = new PeerCache({ file: cacheFile('tfb') })
  try { fs.rmSync(cacheFile('tfb'), { force: true }) } catch {}

  const t0 = Date.now()
  const scout = await SwarmScout.create({ cache, cloud: new CloudCache({ endpoint }) })
  const ranked = await scout.rank(CANDIDATES)
  const tDecision = Date.now() - t0

  const server = new StreamServer()
  const port = await server.listen()
  await server.play(ranked)
  const tReady = Date.now() - t0

  const res = await fetch(`http://localhost:${port}/`, { headers: { Range: 'bytes=0-1048575' } })
  const reader = res.body.getReader()
  await reader.read()
  const tFirstByte = Date.now() - t0
  reader.cancel().catch(() => {})

  console.log(`  decision      ${tDecision}ms`)
  console.log(`  torrent ready ${tReady}ms`)
  console.log(`  first byte    ${tFirstByte}ms   (${server.file.name})`)

  await server.destroy()
  scout.destroy()
  return { tDecision, tReady, tFirstByte }
}

/* ------------------------------------------------------------------ */

function percentile (arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  console.log('swarm-scout benchmark')
  console.log('='.repeat(70))
  console.log(`control plane : ${API || '(none)'}`)
  console.log(`repetitions   : ${REPS}`)

  const scenarios = [
    { id: 'A', name: 'a-cold-nocp', title: 'Cold client, NO control plane', detail: 'the baseline: empty local cache, discovery from scratch', cold: true, endpoint: '' },
    { id: 'B', name: 'b-warm-nocp', title: 'Warm client, NO control plane', detail: 'local node cache populated (what this session already shipped)', cold: false, endpoint: '' },
    { id: 'C', name: 'c-cold-cp', title: 'Cold client, control plane UP', detail: 'the case the Worker exists for', cold: true, endpoint: API },
    { id: 'D', name: 'd-cold-dead', title: 'Cold client, control plane UNREACHABLE', detail: 'must match A — proves accelerator, not dependency', cold: true, endpoint: 'http://10.255.255.1:8787' },
    { id: 'E', name: 'e-warm-cp', title: 'Warm client, control plane UP', detail: 'must not regress vs B', cold: false, endpoint: API }
  ].filter(s => s.endpoint !== null && (API || !s.name.endsWith('-cp')))

  // Warm every scenario that needs it, before any timing starts.
  for (const s of scenarios) {
    if (s.cold) continue
    process.stdout.write(`warming ${s.id}... `)
    try { fs.rmSync(cacheFile(s.name), { force: true }) } catch {}
    await decide({ name: s.name, cold: false, endpoint: s.endpoint })
    const warmed = new PeerCache({ file: cacheFile(s.name) }).getNodes().length
    console.log(warmed > 0 ? `${warmed} nodes cached` : '!! WARM-UP FAILED — this scenario is effectively COLD')
    s.warmedNodes = warmed
  }

  // Round-robin the scenarios, and rotate the starting offset each rep.
  //
  // Running A..E to completion in order biases later scenarios: DNS and
  // DHT routing state are warmed by whatever ran before them. That is not
  // hypothetical — a sequential run produced D (control plane
  // unreachable) beating A (control plane absent) on EVERY order
  // statistic (min -691ms, median -688ms, p90 -1225ms), which is
  // causally impossible, since an unreachable endpoint can only add work.
  const runs = new Map(scenarios.map(s => [s.id, []]))
  for (let rep = 0; rep < REPS; rep++) {
    const order = scenarios.map((_, i) => scenarios[(i + rep) % scenarios.length])
    for (const s of order) {
      const r = await decide({ name: s.name, cold: s.cold, endpoint: s.endpoint })
      runs.get(s.id).push(r)
      console.log(`  rep ${rep + 1}/${REPS}  ${s.id}: ${String(r.ms).padStart(6)}ms  [${r.source}]  cloudWait=${r.cloudWaitMs}ms -> ${r.winner}`)
    }
  }

  const results = scenarios.map(s => {
    const rs = runs.get(s.id)
    const times = rs.map(r => r.ms)
    return {
      ...s,
      median: percentile(times, 50),
      p90: percentile(times, 90),
      min: Math.min(...times),
      max: Math.max(...times),
      cloudWaitMedian: percentile(rs.map(r => r.cloudWaitMs), 50),
      // Split by which path answered. Averaging them hides the thing that
      // matters: a cold control plane cannot answer until a client has
      // reported AND that write has propagated (~50s in KV), so the first
      // reps of a run against an empty cache fall back to a full probe and
      // drag the median toward the baseline.
      sharedRuns: rs.filter(r => r.source === 'shared').length,
      probedRuns: rs.filter(r => r.source === 'probed').length,
      sharedMedian: percentile(rs.filter(r => r.source === 'shared').map(r => r.ms), 50),
      source: rs[0].source,
      runs: rs
    }
  })

  console.log('\n\n' + '='.repeat(70))
  console.log('SUMMARY — time to decision')
  console.log('='.repeat(70))
  console.log('scenario                                    median      p90      min      max  cloudWait  source')
  for (const r of results) {
    console.log(
      `${r.id}. ${r.title.padEnd(38)} ${String(r.median).padStart(6)}ms ${String(r.p90).padStart(6)}ms ` +
      `${String(r.min).padStart(6)}ms ${String(r.max).padStart(6)}ms ${String(r.cloudWaitMedian).padStart(8)}ms  ${r.source}`
    )
  }

  const A = results.find(r => r.id === 'A')
  const C = results.find(r => r.id === 'C')
  const D = results.find(r => r.id === 'D')
  console.log('')
  console.log('  path taken per scenario (shared = answered without probing):')
  for (const r of results) {
    if (!r.endpoint) continue
    console.log(`    ${r.id}: shared ${r.sharedRuns}/${r.sharedRuns + r.probedRuns}` +
      (r.sharedRuns ? `  steady-state median ${r.sharedMedian}ms` : '') +
      (r.probedRuns ? `   (${r.probedRuns} fell back to a full probe - cold cache)` : ''))
  }

  if (A && C) {
    console.log('')
    if (C.sharedRuns) {
      console.log(`  speedup, cache warm (A -> C shared): ${(A.median / Math.max(1, C.sharedMedian)).toFixed(1)}x`)
    }
    console.log(`  speedup, all reps   (A -> C median):  ${(A.median / Math.max(1, C.median)).toFixed(1)}x`)
    if (C.probedRuns) {
      console.log(`  ^ the all-reps figure includes ${C.probedRuns} cold-cache rep(s) that probed;`)
      console.log('    a deployed control plane carrying real traffic is warm, so the first is the honest one')
    }
  }
  if (A && D) {
    // Spread of the two control-plane-free scenarios, as a noise floor.
    const spread = Math.max(A.max - A.min, D.max - D.min)
    const diff = D.median - A.median

    console.log('')
    console.log('  --- cost of an unreachable control plane ---')
    console.log(`  D - A (scenario difference): ${diff >= 0 ? '+' : ''}${diff}ms`)
    console.log(`  run-to-run spread within a scenario: +/-${spread}ms`)

    if (Math.abs(diff) < spread) {
      console.log('  -> the difference is SMALLER THAN THE NOISE; D - A cannot resolve this cost.')
      if (diff < 0) {
        console.log('     (a negative value is not a speed-up: an unreachable endpoint can only add work)')
      }
    }

    // The measurement that actually resolves it.
    console.log('')
    console.log('  measured blocking wait on the control plane (median):')
    console.log(`    D (unreachable): ${D.cloudWaitMedian}ms   <- this IS the failure cost`)
    console.log(`    A (absent)     : ${A.cloudWaitMedian}ms`)
    const real = D.cloudWaitMedian - A.cloudWaitMedian
    console.log(`    isolated cost  : ${real >= 0 ? '+' : ''}${real}ms  ${real < 1500 ? 'PASS, degrades gracefully' : 'FAIL, the control plane is a dependency'}`)
  }

  const acc = await accuracy()
  let tfb = null
  if (DO_TFB) tfb = await timeToFirstByte(API)

  const out = path.join(process.cwd(), 'benchmark-results.json')
  fs.writeFileSync(out, JSON.stringify({ api: API, reps: REPS, ts: Date.now(), results, accuracy: acc, tfb }, null, 2))
  console.log(`\nwrote ${out}`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
