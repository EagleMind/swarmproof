'use strict'

/**
 * Run the DHT crawler.
 *
 *   node tools/crawl.mjs                 crawl until interrupted
 *   node tools/crawl.mjs --stats         print what the index holds, exit
 *   node tools/crawl.mjs --search "…"    search resolved names, exit
 *
 * This is a long-running harvest, not a query. It samples infohashes from
 * the network (BEP 51) and resolves names from peers (BEP 9); coverage
 * accumulates over hours. Leave it running.
 */

import '../env.js'
import SwarmScout from '../swarmScout.js'
import { DhtCrawler } from '../dhtCrawler.js'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => {
  const i = args.indexOf(name)
  return i > -1 ? args[i + 1] : null
}

/** Read-only modes need the database, not the network. */
if (flag('--stats') || flag('--search')) {
  const { DhtCrawler: C } = await import('../dhtCrawler.js')
  const probe = Object.create(C.prototype)
  // Reuse the constructor's schema setup without starting a DHT.
  const { DatabaseSync } = await import('node:sqlite')
  const path = await import('path')
  const db = new DatabaseSync(path.join(process.cwd(), '.dht-index.db'))

  if (flag('--stats')) {
    const r = db.prepare(`SELECT COUNT(*) AS total, SUM(resolved) AS named,
      SUM(CASE WHEN resolved = 0 AND failed < 3 THEN 1 ELSE 0 END) AS pending FROM torrents`).get()
    console.log(`infohashes seen : ${(r.total || 0).toLocaleString()}`)
    console.log(`names resolved  : ${(r.named || 0).toLocaleString()}`)
    console.log(`awaiting names  : ${(r.pending || 0).toLocaleString()}`)
    const recent = db.prepare(
      'SELECT name, size FROM torrents WHERE resolved = 1 ORDER BY last_seen DESC LIMIT 8').all()
    if (recent.length) {
      console.log('\nmost recently named:')
      recent.forEach(x => console.log(`   ${String(x.name).slice(0, 70)}`))
    }
  }

  if (flag('--search')) {
    const q = value('--search') || ''
    const terms = q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    if (!terms.length) { console.log('nothing to search for'); process.exit(0) }
    const where = terms.map(() => 'LOWER(name) LIKE ?').join(' AND ')
    const rows = db.prepare(
      `SELECT info_hash, name, size, hits FROM torrents
       WHERE resolved = 1 AND ${where} ORDER BY hits DESC LIMIT 40`)
      .all(...terms.map(t => `%${t}%`))
    console.log(`${rows.length} match(es) for "${q}"`)
    rows.forEach(r => console.log(
      `   ${(r.size / 1e9).toFixed(2).padStart(7)} GB  ${String(r.name).slice(0, 66)}`))
  }

  db.close()
  process.exit(0)
}

/* ---------------- crawl ---------------- */

const scout = await SwarmScout.create()
await scout.ready()

const crawler = new DhtCrawler({ dht: scout.dht })
crawler.start()

const started = Date.now()
const tick = setInterval(() => {
  const c = crawler.counts()
  const mins = ((Date.now() - started) / 60000).toFixed(1)
  const s = crawler.stats
  // Reported stage by stage. A single "sampled" number looks like progress
  // even when everything downstream of it is returning nothing.
  console.log(
    `[${mins}m] sampled ${s.sampled.toLocaleString()} · ` +
    `leads ${s.leads.toLocaleString()} · ` +
    `peers ${s.peerHits.toLocaleString()}/${(s.peerHits + s.peerMisses).toLocaleString()} · ` +
    `named ${c.named.toLocaleString()}/${s.metaAttempts.toLocaleString()} · ` +
    `unique ${c.total.toLocaleString()} · nodes ${s.queried.toLocaleString()}` +
    ` · found ${s.discovered.toLocaleString()}`)
}, 15000)

async function shutdown () {
  clearInterval(tick)
  const c = crawler.counts()
  console.log(`\nstopping — ${c.total.toLocaleString()} infohashes, ${c.named.toLocaleString()} named`)
  crawler.close()
  scout.destroy()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
