'use strict'

/**
 * Which way of finding peers for a freshly-sampled infohash actually works?
 *
 * The naming stage can only run on hashes it has a peer for, so this ratio
 * sets the ceiling on the whole crawl. Two candidate methods:
 *
 *   direct   one get_peers to the node that sampled the hash. One UDP round
 *            trip, and the node is by definition storing that hash.
 *   lookup   a full iterative DHT lookup. Many round trips, converging on
 *            the nodes actually closest to the hash.
 *
 * The direct method is the one bitmagnet uses and is ~50× cheaper, so it
 * wins outright if the yields are close. If they are not, the cost is worth
 * paying — a hash with no peer is a hash that can never be named.
 *
 *   node tools/peer-yield.mjs [--hashes 40]
 */

import '../env.js'
import crypto from 'crypto'
import SwarmScout from '../swarmScout.js'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i > -1 ? Number(args[i + 1]) : fallback
}
const WANT = value('--hashes', 40)

const scout = await SwarmScout.create()
await new Promise(r => setTimeout(r, 5000))

const dht = scout.dht

const query = (node, message, ms = 3000) => new Promise(resolve => {
  let done = false
  const finish = v => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
  const t = setTimeout(() => finish(null), ms)
  try {
    dht._rpc.query(node, message, (err, res) => finish(err ? null : res?.r))
  } catch { finish(null) }
})

const decodePeers = values => {
  const out = []
  if (!Array.isArray(values)) return out
  for (const v of values) {
    if (v?.length !== 6) continue
    const b = Buffer.from(v)
    const port = b.readUInt16BE(4)
    if (port > 0) out.push({ host: `${b[0]}.${b[1]}.${b[2]}.${b[3]}`, port })
  }
  return out
}

/* ---- collect fresh leads: hash + the node that sampled it ---- */

const leads = []
const seenNodes = new Set()
let queue = dht.toJSON().nodes.slice()

console.log('collecting fresh samples...')
while (leads.length < WANT && queue.length) {
  const node = queue.shift()
  const key = `${node.host}:${node.port}`
  if (seenNodes.has(key)) continue
  seenNodes.add(key)

  const r = await query(node, {
    q: 'sample_infohashes',
    a: { id: dht.nodeId, target: crypto.randomBytes(20) }
  })
  if (!r) continue

  // Spread the crawl using the neighbours every reply carries.
  if (r.nodes?.length) {
    const buf = Buffer.from(r.nodes)
    for (let i = 0; i + 26 <= buf.length; i += 26) {
      queue.push({ host: `${buf[i + 20]}.${buf[i + 21]}.${buf[i + 22]}.${buf[i + 23]}`, port: buf.readUInt16BE(i + 24) })
    }
  }
  if (!r.samples?.length) continue

  const buf = Buffer.from(r.samples)
  // Sample age matters here: `interval` is how long this precomputed subset
  // stays unchanged, and peer entries expire well inside a 6h window.
  for (let i = 0; i + 20 <= buf.length && leads.length < WANT; i += 20) {
    leads.push({ hash: buf.subarray(i, i + 20).toString('hex'), node, interval: Number(r.interval) || null })
  }
}

const intervals = leads.map(l => l.interval).filter(Boolean)
console.log(`collected ${leads.length} leads from ${seenNodes.size} nodes`)
if (intervals.length) {
  console.log(`node-requested interval: median ${intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]}s\n`)
}

/* ---- method A: direct get_peers to the sampling node ---- */

console.log('--- A: direct get_peers to the sampling node ---')
let directHits = 0
let directPeers = 0
const t0 = Date.now()
const directResults = await Promise.all(leads.map(async lead => {
  const r = await query(lead.node, {
    q: 'get_peers',
    a: { id: dht.nodeId, info_hash: Buffer.from(lead.hash, 'hex') }
  })
  const peers = decodePeers(r?.values)
  if (peers.length) { directHits++; directPeers += peers.length }
  return peers
}))
const directMs = Date.now() - t0
console.log(`hits ${directHits}/${leads.length} (${(100 * directHits / leads.length).toFixed(1)}%), ` +
  `${directPeers} peers total, ${directMs}ms wall clock\n`)

/* ---- method B: full iterative lookup ---- */

console.log('--- B: full iterative DHT lookup ---')
const lookup = (hash, windowMs = 6000) => new Promise(resolve => {
  const peers = []
  const onPeer = (peer, h) => { if (h?.toString('hex') === hash) peers.push(peer) }
  dht.on('peer', onPeer)
  try { dht.lookup(hash) } catch { /* busy */ }
  setTimeout(() => { dht.removeListener('peer', onPeer); resolve(peers) }, windowMs)
})

let lookupHits = 0
let lookupPeers = 0
const t1 = Date.now()
const lookupResults = await Promise.all(leads.map(async lead => {
  const peers = await lookup(lead.hash)
  if (peers.length) { lookupHits++; lookupPeers += peers.length }
  return peers
}))
const lookupMs = Date.now() - t1
console.log(`hits ${lookupHits}/${leads.length} (${(100 * lookupHits / leads.length).toFixed(1)}%), ` +
  `${lookupPeers} peers total, ${lookupMs}ms wall clock\n`)

/* ---- overlap ---- */

let both = 0
let onlyLookup = 0
for (let i = 0; i < leads.length; i++) {
  const a = directResults[i].length > 0
  const b = lookupResults[i].length > 0
  if (a && b) both++
  else if (b && !a) onlyLookup++
}
console.log('--- verdict ---')
console.log(`found by both        : ${both}`)
console.log(`found ONLY by lookup : ${onlyLookup}  ← what the direct method misses`)
console.log(`found by neither     : ${leads.length - both - onlyLookup - (directHits - both)}`)

scout.destroy()
process.exit(0)
