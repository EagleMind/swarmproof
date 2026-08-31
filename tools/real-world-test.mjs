'use strict'

/**
 * End-to-end test against the real BitTorrent network and the deployed
 * control plane. Nothing here is mocked: real trackers, the real DHT, real
 * peers, real bytes off the wire.
 *
 * Content is Blender Foundation open movies (CC-BY) — freely
 * redistributable, so a test that actually downloads from strangers is
 * legitimate. A fourth candidate is a random infohash that exists nowhere:
 * it is the negative control. Without it "everything scored > 0" proves
 * nothing, because a scorer that returns a constant passes too.
 *
 * Run: node tools/real-world-test.mjs
 */

import '../env.js'
import http from 'node:http'
import crypto from 'node:crypto'
import SwarmScout from '../swarmScout.js'
import StreamServer from '../streamServer.js'
import { fetchFromAny } from '../metainfo.js'
import { PeerTable } from '../peerTable.js'
import ContentFilter from '../contentFilter.js'

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce'
]

function candidate (label, infoHash) {
  return {
    label,
    infoHash,
    magnetURI: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(label)}` +
      TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join(''),
    trackers: TRACKERS
  }
}

// Known-good, verifiable ground truth. `expect` is what a correct
// ut_metadata fetch must return — checking the name is what separates
// "a peer answered" from "a peer answered with the right torrent".
const CANDIDATES = [
  { ...candidate('Sintel', '08ada5a7a6183aae1e09d831df6748d566095a10'), expect: /sintel/i },
  { ...candidate('Big Buck Bunny', 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'), expect: /bunny/i },
  { ...candidate('Cosmos Laundromat', 'c9e15763f722f23e98a29decdfae341b98d53056'), expect: /cosmos/i }
]

// Deterministic so reruns are comparable, and not derived from any real
// torrent. Nothing on the network has this hash.
const DEAD_HASH = crypto.createHash('sha1').update('swarm-scout-negative-control-v1').digest('hex')
const DEAD = candidate('(negative control)', DEAD_HASH)

const results = []
function check (name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  return pass
}

const ms = t0 => `${Date.now() - t0}ms`

async function getJson (url, timeoutMs = 8000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    return { status: res.status, body: await res.json() }
  } finally {
    clearTimeout(timer)
  }
}

/** GET a byte range off the local stream server - the actual proof. */
function getRange (port, bytes) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: { Range: `bytes=0-${bytes - 1}` }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('range request timed out')))
  })
}

async function main () {
  const api = process.env.SWARM_SCOUT_API
  let scout = null
  let server = null

  try {
    // ---- 1. Deployed control plane ------------------------------------
    console.log('\n[1] Control plane')
    if (!api) {
      check('SWARM_SCOUT_API configured', false, 'unset - the rest runs local-only')
    } else {
      const t0 = Date.now()
      const status = await getJson(`${api}/v1/status`)
      check('GET /v1/status', status.status === 200, `${status.status} in ${ms(t0)}`)
      console.log(`        pool=${status.body?.pool?.nodes} health=${status.body?.healthEntries} floor=${status.body?.floor}`)

      const t1 = Date.now()
      const nodes = await getJson(`${api}/v1/dht/nodes`)
      const n = nodes.body?.nodes?.length || 0
      check('GET /v1/dht/nodes returns bootstrap nodes', nodes.status === 200 && n > 0, `${n} nodes in ${ms(t1)}`)
    }

    // ---- 2. Ranking real swarms ---------------------------------------
    console.log('\n[2] Discovery + ranking (cold)')
    scout = await SwarmScout.create()
    console.log(`        control plane: ${scout.cloud.enabled ? scout.cloud.endpoint : 'disabled'}`)

    // Record what the client actually sends upstream.
    //
    // Reading the write back over HTTP cannot confirm it: a complete answer
    // is edge-cached for 60s under a key derived only from the sorted
    // hashes, so a GET after the write returns the pre-write body with its
    // `age` frozen at cache time - verified directly, two GETs a POST apart
    // returned byte-identical ages while a single-hash key (a different
    // cache key) showed the new value. That is correct behaviour, not a
    // bug: clients re-check freshness against the absolute `ts`, which the
    // cache cannot skew. It just means the write has to be observed here.
    const writes = []
    const origFetch = scout.cloud._fetch.bind(scout.cloud)
    scout.cloud._fetch = async (path, opts = {}) => {
      const out = await origFetch(path, opts)
      if (opts.method === 'POST') writes.push({ path, out })
      return out
    }

    const t2 = Date.now()
    const ranked = await scout.rank([...CANDIDATES, DEAD])
    const coldMs = Date.now() - t2
    console.log(`        decided in ${coldMs}ms`)
    for (const r of ranked) {
      console.log(`        ${(r.label || r.infoHash).padEnd(20)} score=${String(r.score).padStart(6)} peers=${String(r.peers?.length || 0).padStart(3)} [${r.source || 'probed'}] ${JSON.stringify(r.sources)}`)
    }

    check('every candidate returned', ranked.length === 4, `${ranked.length}/4`)

    const live = ranked.filter(r => r.infoHash !== DEAD_HASH)
    const dead = ranked.find(r => r.infoHash === DEAD_HASH)
    const withPeers = live.filter(r => (r.peers?.length || 0) > 0)
    check('at least one real swarm yielded peers', withPeers.length > 0,
      `${withPeers.length}/3 candidates, ${live.reduce((a, r) => a + (r.peers?.length || 0), 0)} peers total`)

    // The discriminator. A scorer that cannot tell a live swarm from a hash
    // nobody has ever seen is not ranking anything.
    const bestLive = Math.max(...live.map(r => r.score))
    check('negative control ranks below every live swarm',
      !!dead && dead.score < bestLive && ranked[ranked.length - 1].infoHash === DEAD_HASH,
      `dead=${dead?.score} best live=${bestLive}, dead placed ${ranked.indexOf(dead) + 1}/4`)

    // ---- 3. ut_metadata off a discovered peer --------------------------
    // A tracker will happily hand back an address that is firewalled, gone,
    // or seeding something else. The only way to know a peer is real is to
    // ask it for the torrent and check what comes back.
    console.log('\n[3] Metadata from a live peer (ut_metadata over TCP)')
    const table = new PeerTable()
    const filter = new ContentFilter()
    let converted = 0

    for (const r of live) {
      const peers = r.peers || []
      if (!peers.length) {
        check(`${r.label}: metadata`, false, 'no peers discovered to ask')
        continue
      }
      // maxPeers 40, not the crawler's 8.
      //
      // The two peer sources are not the same quality and the budget has to
      // follow. Crawler peers come from a get_peers reply from the node that
      // *just* sampled the hash, so they are minutes old and ~34% connect;
      // 8 is plenty. These come from an iterative DHT lookup against stored
      // records for a years-old swarm, and measured 8/60 = 13% TCP-connect
      // on Sintel. At 13%, 8 peers is an expected 1 connection - a coin
      // flip dressed up as a test. Of the peers that did connect, 5/8
      // returned metadata, so the wire path is fine; only the sample was
      // short.
      const t3 = Date.now()
      const MAX_PEERS = 40
      const meta = await fetchFromAny(r.infoHash, peers, { maxPeers: MAX_PEERS, table })
      const src = CANDIDATES.find(c => c.infoHash === r.infoHash)

      if (!meta?.ok) {
        check(`${r.label}: metadata`, false, `no answer from ${Math.min(MAX_PEERS, peers.length)} peers in ${ms(t3)}`)
        continue
      }
      converted++
      check(`${r.label}: metadata matches the expected torrent`, src.expect.test(meta.name),
        `"${meta.name}" ${(meta.size / 1e6).toFixed(1)}MB, ${meta.files} file(s) in ${ms(t3)}`)

      // The filter gates persistence, so it must be exercised on real
      // resolved content - name and paths together, as it runs in the crawler.
      const verdict = filter.check(meta)
      check(`${r.label}: passes the content filter`, !verdict.blocked,
        verdict.blocked ? `blocked: ${verdict.reason}` : `clean (${meta.paths?.length || 0} paths checked)`)
    }
    check('at least one hash converted to metadata', converted > 0, `${converted}/3`)
    console.log(`        peer table: ${JSON.stringify(table.stats)}`)

    // ---- 4. Real bytes ------------------------------------------------
    console.log('\n[4] Streaming real bytes')
    server = new StreamServer()
    const port = await server.listen()
    const t4 = Date.now()
    await server.play(ranked)
    const playMs = Date.now() - t4
    check('stream server picked a file', !!server.file,
      server.file ? `"${server.file.name}" ${(server.file.length / 1e6).toFixed(1)}MB in ${playMs}ms` : 'none')

    if (server.file) {
      const WANT = 256 * 1024
      const t5 = Date.now()
      const res = await getRange(port, WANT)
      const got = res.body.length
      check('HTTP 206 partial content', res.status === 206,
        `status ${res.status}, content-range: ${res.headers['content-range']}`)
      // WebTorrent only releases bytes whose piece hash verified against the
      // infohash-anchored metadata, so bytes arriving here are the real
      // file - which is the whole point of doing this over HTTP.
      check('piece-verified bytes off the swarm', got === WANT,
        `${got}/${WANT} bytes in ${ms(t5)} (${(got / 1024 / Math.max(0.001, (Date.now() - t5) / 1000)).toFixed(0)} KB/s)`)
      check('payload is real data', res.body.some(b => b !== 0),
        `first bytes: ${res.body.subarray(0, 12).toString('hex')}`)
      console.log(`        swarm: ${server.torrent?.numPeers} peers connected, ${(server.torrent?.downloaded / 1e6).toFixed(2)}MB down`)
    }

    // ---- 5. The control-plane round trip ------------------------------
    // Stage 2 reported health up to the deployment. If it landed, a second
    // client asking the same question is answered from shared state instead
    // of re-probing - which is the reason the worker exists.
    if (api) {
      console.log('\n[5] Shared-health round trip through the deployment')
      await new Promise(r => setTimeout(r, 3000)) // the health write is fire-and-forget
      const q = live.map(r => `ih=${r.infoHash.toLowerCase()}`).sort().join('&')
      const health = await getJson(`${api}/v1/health?${q}`)
      // The client's own view of what it sent. Without this, a failure here
      // is indistinguishable between "the worker dropped it" and "the client
      // never sent it" - and it is the second one: a read that overruns its
      // 300ms budget trips the breaker, and the health write that follows
      // ~1s later is short-circuited inside the 10s open window.
      console.log(`        client cloud stats: ${JSON.stringify(scout.cloud.stats)}`)

      const healthWrite = writes.find(w => w.path === '/v1/health')
      check('the health write was sent, not short-circuited', !!healthWrite,
        healthWrite ? `POST /v1/health -> ${JSON.stringify(healthWrite.out)}` : 'no POST /v1/health was attempted')

      // written or coalesced both mean the contribution reached the worker
      // and the stored value is current; coalesced simply means another
      // client got there inside the 120s window.
      const o = healthWrite?.out || {}
      const accepted = (o.written || 0) + (o.coalesced || 0)
      check('the worker accepted this run’s health report', accepted > 0,
        `written=${o.written} coalesced=${o.coalesced} ignoredZero=${o.ignoredZero} rejected=${o.rejected?.length}`)
      check('the breaker did not suppress any contribution', scout.cloud.stats.shortCircuited === 0,
        `shortCircuited=${scout.cloud.stats.shortCircuited}`)

      const body = health.body?.health || health.body || {}
      console.log(`        read-back (may be edge-cached): ${Object.keys(body).length}/3 present, ages ${Object.values(body).map(e => `${Math.round(e.age / 1000)}s`).join(',')}`)

      const scout2 = await SwarmScout.create()
      const t6 = Date.now()
      const warm = await scout2.rank(CANDIDATES)
      const warmMs = Date.now() - t6
      const fromShared = warm.filter(r => r.source === 'shared').length
      check('a second client decides from shared health', fromShared > 0 || warmMs < coldMs,
        `${warmMs}ms warm vs ${coldMs}ms cold, ${fromShared}/3 served from shared`)
      scout2.destroy()
    }
  } finally {
    try { await server?.destroy() } catch { /* shutting down */ }
    try { scout?.destroy() } catch { /* shutting down */ }
  }

  const failed = results.filter(r => !r.pass)
  console.log(`\n${'='.repeat(64)}`)
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  failed.forEach(f => console.log(`  FAILED: ${f.name} - ${f.detail}`))
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
