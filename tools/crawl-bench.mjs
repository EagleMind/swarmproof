'use strict'

/**
 * Time-boxed crawl, reported as a rate.
 *
 * The only number that matters for this stage is **named torrents per
 * minute** — hashes harvested and peers found are intermediate, and each can
 * look healthy while the next stage produces nothing. This runs the crawler
 * for a fixed wall-clock window and reports the conversion at every stage,
 * so a regression can be located rather than merely noticed.
 *
 *   node tools/crawl-bench.mjs [--minutes 5]
 */

import '../env.js'
import SwarmScout from '../swarmScout.js'
import { DhtCrawler } from '../dhtCrawler.js'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i > -1 ? Number(args[i + 1]) : fallback
}
const MINUTES = value('--minutes', 5)

const scout = await SwarmScout.create()
const crawler = new DhtCrawler({ dht: scout.dht })

const before = crawler.counts()
const t0 = Date.now()
crawler.start()

console.log(`\nbenchmarking ${MINUTES} minute(s) — starting from ` +
  `${before.total.toLocaleString()} hashes, ${before.named.toLocaleString()} named\n`)

const tick = setInterval(() => {
  const c = crawler.counts()
  const s = crawler.stats
  const mins = (Date.now() - t0) / 60000
  console.log(
    `[${mins.toFixed(1)}m] +${(c.named - before.named).toString().padStart(4)} names` +
    `  (${((c.named - before.named) / mins).toFixed(1)}/min)` +
    `   sampled ${s.sampled.toLocaleString()}` +
    `   peers ${s.peerHits}/${s.peerHits + s.peerMisses}` +
    `   meta ${s.named}/${s.metaAttempts}`)
}, 30000)

await new Promise(r => setTimeout(r, MINUTES * 60000))

clearInterval(tick)
const after = crawler.counts()
const s = crawler.stats
const mins = (Date.now() - t0) / 60000
const newNames = after.named - before.named
const peerTried = s.peerHits + s.peerMisses

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : 'n/a'

console.log(`\n${'='.repeat(58)}`)
console.log(`RESULT over ${mins.toFixed(1)} minutes`)
console.log('='.repeat(58))
console.log(`  names resolved      ${newNames}   →  ${(newNames / mins).toFixed(1)} per minute`)
console.log(`  hashes harvested    ${(after.total - before.total).toLocaleString()}`)
console.log('\n  stage conversion')
console.log(`    nodes queried     ${s.queried.toLocaleString()}  (${s.discovered.toLocaleString()} addresses found)`)
console.log(`    infohashes seen   ${s.sampled.toLocaleString()}`)
console.log(`    → had peers       ${s.peerHits.toLocaleString()} / ${peerTried.toLocaleString()}   ${pct(s.peerHits, peerTried)}`)
console.log(`    → named           ${s.named.toLocaleString()} / ${s.metaAttempts.toLocaleString()}   ${pct(s.named, s.metaAttempts)}`)
console.log(`    dropped (had peers, never tried)  ${s.dropped.toLocaleString()}`)
console.log(`    blocked by content filter         ${s.blocked.toLocaleString()}`)

const t = crawler.peerTable.summary()
console.log('\n  peer table (reuse across hashes)')
console.log(`    addresses tracked ${t.tracked.toLocaleString()}   ${t.alive.toLocaleString()} answered, ${t.dead.toLocaleString()} known dead`)
console.log(`    connects skipped  ${t.skipped.toLocaleString()}   ← dead addresses not re-tried`)
console.log(`    known-good reused ${t.hits.toLocaleString()}   on ${t.promoted.toLocaleString()} hashes`)
console.log('='.repeat(58) + '\n')

crawler.close()
scout.destroy()
process.exit(0)
