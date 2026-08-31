'use strict'

import SwarmScout from './swarmScout.js'
import StreamServer from './streamServer.js'

/**
 * Example end-to-end usage.
 *
 * `candidates` would come from wherever *you* legitimately source
 * content metadata (your own indexer of licensed/owned/public-domain
 * content, a user-supplied magnet link, etc.) — this module doesn't
 * care where they came from, only how to pick the healthiest one.
 *
 * The three below are Blender Foundation open movies (CC-BY) — freely
 * redistributable, so they're safe to develop against. Note they are
 * three *different films*, not three releases of one title: that's fine
 * for exercising the ranking machinery, but in production a candidate
 * set should be alternate releases of the SAME content, since failover
 * assumes any candidate is an acceptable substitute for the others.
 *
 * Tracker list is restricted to ones measured as live from this machine.
 * Deliberately omitted:
 *   tracker.openbittorrent.com:6969 - never answered, burned the full 8s
 *   tracker.gbitt.info              - HTTPS scrape failed immediately
 */
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

async function main () {
  const candidates = [
    candidate('Sintel', '08ada5a7a6183aae1e09d831df6748d566095a10'),
    candidate('Big Buck Bunny', 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'),
    candidate('Cosmos Laundromat', 'c9e15763f722f23e98a29decdfae341b98d53056')
  ]

  // SwarmScout.create() is async because a *cold* client (no DHT nodes on
  // disk) can profitably wait ~1 RTT for shared bootstrap nodes. A warm
  // client never waits — see the constructor.
  const scout = await SwarmScout.create()
  if (scout.cloud.enabled) console.log(`Control plane: ${scout.cloud.endpoint}`)

  // Note there is no `await scout.ready()` here.
  //
  // rank() waits for the DHT only on the path that actually needs it. When
  // shared health covers every candidate it answers without touching the
  // DHT at all, and bootstrap continues in the background — which is the
  // whole point of the control plane. Blocking on ready() first would
  // hand back the 2.5-5s it exists to avoid.
  const t0 = Date.now()
  console.log('Scoring candidates...')
  const ranked = await scout.rank(candidates)
  console.log(`Decision in ${Date.now() - t0}ms:`)
  ranked.forEach(r => console.log(`  ${(r.label || r.infoHash).padEnd(20)} score=${String(r.score).padStart(6)} [${r.source}]`, r.sources))

  const server = new StreamServer()
  const port = await server.listen()
  await server.play(ranked)

  console.log(`\nStreaming "${server.file.name}" (${(server.file.length / 1e6).toFixed(1)} MB)`)
  console.log(`Streaming at: http://localhost:${port}/`)
  console.log('(point a <video> tag, mpv, or VLC network stream at that URL)')

  scout.ready().then(up => console.log(`[scout] DHT ${up ? 'ready' : 'unavailable'} (background)`))

  process.on('SIGINT', async () => {
    await server.destroy()
    scout.destroy()
    process.exit(0)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
