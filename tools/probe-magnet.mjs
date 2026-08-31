'use strict'

/**
 * Probe one magnet link end to end and say whether anything is actually
 * there. The discovery layer pointed at a single target, for when you have
 * a link in hand and want a verdict rather than a ranking.
 *
 * Deliberately does NOT stream. Streaming a hash with no swarm just hangs
 * until a watchdog fires, and "it hung" is not a useful answer - the whole
 * point here is to distinguish a dead swarm from a slow one, quickly.
 *
 * Run: node tools/probe-magnet.mjs "magnet:?xt=urn:btih:..."
 */

import '../env.js'
import SwarmScout from '../swarmScout.js'
import { fetchFromAny } from '../metainfo.js'
import { PeerTable } from '../peerTable.js'
import ContentFilter from '../contentFilter.js'

const MAX_PEERS = 40

function parseMagnet (uri) {
  if (!uri.startsWith('magnet:')) throw new Error('not a magnet: URI')
  const q = new URLSearchParams(uri.slice(uri.indexOf('?') + 1))
  const xt = q.getAll('xt').find(x => /^urn:btih:/i.test(x))
  if (!xt) throw new Error('no urn:btih: in xt - only v1 infohashes are supported')

  let hash = xt.slice('urn:btih:'.length).trim()
  // Magnets carry the hash as 40 hex chars or 32 base32 chars.
  if (/^[a-fA-F0-9]{40}$/.test(hash)) {
    hash = hash.toLowerCase()
  } else if (/^[a-zA-Z2-7]{32}$/.test(hash)) {
    hash = Buffer.from(hash.toUpperCase(), 'base32').toString('hex')
  } else {
    throw new Error(`malformed infohash: ${hash.slice(0, 64)}`)
  }

  return {
    infoHash: hash,
    label: q.get('dn') || hash,
    trackers: q.getAll('tr'),
    magnetURI: uri
  }
}

async function main () {
  const uri = process.argv[2]
  if (!uri) {
    console.error('usage: node tools/probe-magnet.mjs "magnet:?xt=urn:btih:..."')
    process.exit(2)
  }

  const c = parseMagnet(uri)
  console.log(`\nname      ${c.label}`)
  console.log(`infohash  ${c.infoHash}`)
  console.log(`trackers  ${c.trackers.length}`)

  // A hash that is all one repeated nibble is not a real torrent - it is a
  // placeholder somebody typed. Worth naming, because the probe below will
  // still dutifully ask the whole internet about it.
  if (/^(.)\1{39}$/.test(c.infoHash)) {
    console.log('          note: degenerate hash (all identical characters) - almost certainly a placeholder')
  }

  const scout = await SwarmScout.create()
  console.log(`\nprobing (trackers + DHT)...`)
  const t0 = Date.now()
  const [r] = await scout.rank([c])
  const rankMs = Date.now() - t0

  console.log(`\nscore     ${r.score}   (in ${rankMs}ms)`)
  console.log(`seeders   ${r.sources.seeders}`)
  console.log(`leechers  ${r.sources.leechers}`)
  console.log(`dht peers ${r.sources.dhtCount}`)

  let meta = null
  if (r.peers?.length) {
    console.log(`\nasking up to ${Math.min(MAX_PEERS, r.peers.length)} of ${r.peers.length} peers for metadata...`)
    const t1 = Date.now()
    meta = await fetchFromAny(c.infoHash, r.peers, { maxPeers: MAX_PEERS, table: new PeerTable() })
    if (meta?.ok) {
      console.log(`\nresolved  "${meta.name}"`)
      console.log(`size      ${(meta.size / 1e6).toFixed(1)} MB in ${meta.files} file(s)   (${Date.now() - t1}ms)`)
      const verdict = new ContentFilter().check(meta)
      console.log(`filter    ${verdict.blocked ? 'BLOCKED - ' + verdict.reason : 'clean'}`)
      if (!verdict.blocked) {
        for (const p of (meta.paths || []).slice(0, 8)) console.log(`            ${p}`)
      }
    } else {
      console.log(`no peer answered in ${Date.now() - t1}ms`)
    }
  }

  // The verdict. Peers are the evidence that matters: tracker counts are a
  // claim, a peer that served metadata is proof.
  console.log('')
  if (meta?.ok) {
    console.log('VERDICT   real and reachable - metadata served by a live peer')
  } else if (r.peers?.length) {
    console.log('VERDICT   peers exist but none served metadata - swarm may be firewalled or stale')
  } else if (r.sources.seeders > 0 || r.sources.leechers > 0) {
    console.log('VERDICT   trackers claim a swarm but no peer address was found - treat as unproven')
  } else {
    console.log('VERDICT   nothing there - no seeders, no leechers, no DHT peer, no metadata')
  }

  scout.destroy()
  process.exit(0)
}

main().catch(err => { console.error(err.message); process.exit(1) })
