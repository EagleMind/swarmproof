'use strict'

/**
 * Where does a metadata fetch actually spend its time?
 *
 * The naming stage walks a peer list in order, so its cost is dominated by
 * how long a *failing* peer takes to fail. This measures the two phases
 * separately against real peers — TCP connect, then everything after it —
 * so the connect deadline can be set from the distribution rather than from
 * a guess.
 *
 *   node tools/connect-timing.mjs [--peers 120]
 */

import '../env.js'
import net from 'net'
import SwarmScout from '../swarmScout.js'
import { makeCandidate, PRESETS } from '../catalog.js'
import { fetchMetadata } from '../metainfo.js'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i > -1 ? Number(args[i + 1]) : fallback
}
const WANT = value('--peers', 120)

const scout = await SwarmScout.create()

// Gather a realistic peer population: live swarms, so the sample contains
// both peers that answer and the usual proportion that do not.
const ranked = await scout.rank(PRESETS.map(p => makeCandidate(p.label, p.infoHash)))
const population = []
for (const r of ranked) {
  for (const peer of r.peers || []) population.push({ ...peer, infoHash: r.infoHash })
}
console.log(`peer population: ${population.length} across ${ranked.length} swarms\n`)

const sample = population.slice(0, WANT)

/** Phase 1 alone: how long does a bare TCP connect take, or fail to? */
function timeConnect (peer, capMs = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let done = false
    const finish = outcome => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* already gone */ }
      resolve({ outcome, ms: Date.now() - t0 })
    }
    const timer = setTimeout(() => finish('timeout'), capMs)
    const socket = net.connect({ host: peer.host, port: peer.port })
    socket.on('connect', () => finish('connected'))
    socket.on('error', () => finish('refused'))
  })
}

console.log(`--- phase 1: TCP connect, ${sample.length} peers, 8s cap ---`)
const connects = []
const CHUNK = 40
for (let i = 0; i < sample.length; i += CHUNK) {
  connects.push(...await Promise.all(sample.slice(i, i + CHUNK).map(p => timeConnect(p))))
}

const connected = connects.filter(c => c.outcome === 'connected').map(c => c.ms).sort((a, b) => a - b)
const refused = connects.filter(c => c.outcome === 'refused')
const timedOut = connects.filter(c => c.outcome === 'timeout')

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null

console.log(`connected : ${connected.length}`)
console.log(`refused   : ${refused.length}  (fail fast — cost is near zero either way)`)
console.log(`timed out : ${timedOut.length}  (these are what a connect deadline saves)`)
if (connected.length) {
  console.log(`\nconnect latency of peers that DID connect:`)
  console.log(`  p50 ${pct(connected, 0.5)}ms   p90 ${pct(connected, 0.9)}ms   ` +
    `p95 ${pct(connected, 0.95)}ms   p99 ${pct(connected, 0.99)}ms   max ${connected.at(-1)}ms`)
  for (const cut of [500, 800, 1000, 1200, 1500, 2000, 3000]) {
    const kept = connected.filter(ms => ms <= cut).length
    console.log(`  cut at ${String(cut).padStart(4)}ms → keeps ${kept}/${connected.length} ` +
      `(${(100 * kept / connected.length).toFixed(1)}% of reachable peers)`)
  }
}

/** Phase 2: full fetch against peers that connected, to size the transfer. */
const reachable = sample.filter((_, i) => connects[i].outcome === 'connected').slice(0, 30)
if (reachable.length) {
  console.log(`\n--- phase 2: full metadata fetch, ${reachable.length} reachable peers ---`)
  const results = await Promise.all(
    reachable.map(p => fetchMetadata(p.infoHash, p, 15000, 8000)))
  const ok = results.filter(Boolean)
  console.log(`resolved  : ${ok.length}/${reachable.length}`)
  if (ok.length) {
    const totals = ok.map(r => r.totalMs).sort((a, b) => a - b)
    const conns = ok.map(r => r.connectMs).sort((a, b) => a - b)
    console.log(`  connect portion : p50 ${pct(conns, 0.5)}ms  p90 ${pct(conns, 0.9)}ms`)
    console.log(`  total           : p50 ${pct(totals, 0.5)}ms  p90 ${pct(totals, 0.9)}ms  max ${totals.at(-1)}ms`)
    console.log(`  → post-connect work is p50 ${pct(totals, 0.5) - pct(conns, 0.5)}ms, ` +
      'which is what the overall budget must cover')
  }
}

scout.destroy()
process.exit(0)
