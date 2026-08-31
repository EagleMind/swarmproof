'use strict'

import net from 'net'
import crypto from 'crypto'
import bencode from 'bencode'
import Protocol from 'bittorrent-protocol'
import utMetadata from 'ut_metadata'

/**
 * Fetch a torrent's metadata from one peer, over one TCP connection.
 *
 * This is the whole naming stage, and the reason it is written out rather
 * than delegated: the obvious way to learn a torrent's name is to hand the
 * infohash to a torrent client and wait, but a client is built to *download
 * the torrent*. It constructs a torrent object, a piece store, a discovery
 * loop and a swarm, then holds all of it open. That machinery costs enough
 * per hash that only a handful can be in flight at once, and this stage
 * needs hundreds.
 *
 * What is actually required is much smaller: connect, handshake, ask for the
 * metadata (BEP 9), hang up. `bittorrent-protocol` speaks the wire and
 * `ut_metadata` speaks the extension — both already present as WebTorrent's
 * own dependencies — so the client is the only part being skipped, not the
 * protocol.
 *
 * Nothing is downloaded and nothing is written to disk. The peer is asked
 * for the info dictionary, which is a few hundred bytes, and the connection
 * is destroyed the moment it arrives.
 */

const DEFAULT_TIMEOUT_MS = 6000

/**
 * Separate, much tighter deadline for the TCP connect alone.
 *
 * The overall budget has to cover a multi-piece metadata transfer, so it
 * cannot be short. But almost none of the waste is in the transfer — it is
 * in peers that never complete a handshake at all, because the address is
 * stale or the host silently drops packets. Those consume the *entire*
 * budget while a peer that is going to answer completes its connect in about
 * one round trip.
 *
 * Splitting the two means a dead peer costs a fraction of a live one instead
 * of the same as one, which matters because the peer list is walked in
 * order: four dead peers at the full budget is 24s of a worker's life for
 * one hash.
 *
 * Measured over 140 real peers (tools/connect-timing.mjs):
 *
 *   66%  never complete a connect at all — pure waste under a flat budget
 *   21%  refused, which costs nothing either way
 *   13%  connected, at p50 141ms and a maximum of 520ms
 *
 * So every peer worth having is in under ~0.5s, and 800ms would keep all of
 * them. 1200ms is that floor plus headroom for peers further away than
 * anything in the sample, and still cuts the cost of a dead peer 5×.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 1200

/**
 * Cap on file paths carried out of a torrent's metadata.
 *
 * Only the content filter consumes these, and it needs a representative
 * subject string rather than a complete manifest. Some torrents hold tens of
 * thousands of files; keeping them all would put the whole manifest in memory
 * once per hash across 300 concurrent fetches. bitmagnet caps at the same
 * order of magnitude (save_files_threshold: 100).
 */
const MAX_PATHS = 100

/**
 * Our peer id.
 *
 * Azureus-style, honestly identifying the client rather than mimicking a
 * popular one. A crawler that lies about what it is makes the network harder
 * for everyone else to reason about.
 */
const PEER_ID = Buffer.concat([
  Buffer.from('-SS0200-'),
  crypto.randomBytes(12)
])

/**
 * @param {string} infoHash            40-char hex
 * @param {{host: string, port: number}} peer
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, connected: boolean, name?, size?, files?, paths?}>}
 */
export function fetchMetadata (infoHash, peer, timeoutMs = DEFAULT_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise(resolve => {
    let socket = null
    let wire = null
    let done = false
    const t0 = Date.now()
    let connectedAt = null

    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(connectTimer)
      // Order matters: destroying the wire first stops it writing into a
      // socket that is about to go away, which otherwise surfaces as an
      // ECONNRESET on a request that actually succeeded.
      try { wire?.destroy() } catch { /* already gone */ }
      try { socket?.destroy() } catch { /* already gone */ }

      // Always an object, never null.
      //
      // `connected` is the field that matters to the caller's bookkeeping:
      // a peer that completed a TCP handshake and then failed to serve the
      // metadata is *alive* — it simply does not hold this torrent, or does
      // not speak the extension. Collapsing both failures into `null` would
      // let PeerTable mark a perfectly good address dead, and those are the
      // scarce ones. Phase timings ride along so deadlines can be tuned
      // against measurement rather than intuition.
      resolve({
        ok: Boolean(value),
        connected: connectedAt !== null,
        connectMs: connectedAt ? connectedAt - t0 : null,
        totalMs: Date.now() - t0,
        ...(value || {})
      })
    }

    // Overall deadline: covers handshake plus a possibly multi-piece
    // metadata transfer.
    const timer = setTimeout(() => finish(null), timeoutMs)

    // Connect deadline: fires only while the TCP connection is still being
    // established. Once connected it is cancelled and the overall budget
    // takes over, so a slow *transfer* is never cut short — only a peer that
    // never came up at all.
    const connectTimer = setTimeout(() => {
      if (!connectedAt) finish(null)
    }, connectTimeoutMs)

    try {
      socket = net.connect({ host: peer.host, port: peer.port })
    } catch {
      return finish(null)
    }

    socket.setNoDelay(true)
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('timeout', () => finish(null))
    socket.setTimeout(timeoutMs)

    socket.on('connect', () => {
      if (done) return
      connectedAt = Date.now()
      clearTimeout(connectTimer)
      try {
        wire = new Protocol()
        wire.on('error', () => finish(null))
        socket.pipe(wire).pipe(socket)

        wire.use(utMetadata())
        wire.ut_metadata.on('warning', () => finish(null))

        wire.ut_metadata.on('metadata', raw => {
          try {
            // ut_metadata has already verified SHA1(info) against the
            // infohash before emitting, so this cannot be a mismatched
            // torrent — only malformed bencode, which decode() will throw on.
            const info = bencode.decode(raw).info
            const name = info.name
              ? Buffer.from(info.name).toString('utf8')
              : null
            if (!name) return finish(null)

            // Single-file torrents carry `length`; multi-file ones carry a
            // `files` list and no top-level length.
            const files = Array.isArray(info.files) ? info.files : null
            const size = files
              ? files.reduce((sum, f) => sum + (Number(f.length) || 0), 0)
              : Number(info.length) || 0

            // The file paths, not just how many there are.
            //
            // contentFilter matches over the name *and* every path, because a
            // torrent whose name looks innocuous routinely carries the real
            // content in its file names — so a count is not enough to make a
            // decision on. Capped, because some torrents hold many thousands
            // of files and the filter only needs a representative subject
            // string; bitmagnet caps the same way (save_files_threshold: 100).
            const paths = (files || [])
              .slice(0, MAX_PATHS)
              .map(f => (Array.isArray(f.path) ? f.path : [])
                .map(seg => Buffer.from(seg).toString('utf8')).join('/'))
              .filter(Boolean)

            finish({ name, size, files: files ? files.length : 1, paths })
          } catch {
            finish(null)
          }
        })

        wire.handshake(infoHash, PEER_ID, { dht: true })
        wire.ut_metadata.fetch()
      } catch {
        finish(null)
      }
    })
  })
}

/**
 * Try peers in order until one answers.
 *
 * Sequential rather than parallel, deliberately. Peers for one hash are
 * highly correlated — if the swarm is alive the first peer usually answers,
 * and if it is dead none of them will — so racing them mostly multiplies
 * connections to dead swarms, which is both wasteful and rude. The budget
 * that matters is how many *hashes* are in flight, not how many peers per
 * hash.
 */
export async function fetchFromAny (infoHash, peers, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPeers = 8,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  table = null,
  concurrency = 1
} = {}) {
  // The table both prunes and reorders: addresses it knows to be
  // unreachable are dropped without spending a connection, and ones that
  // have answered before go to the front. Since the loop stops at the first
  // success, promoting a known-good address converts the hash on the first
  // connection instead of the fifth.
  const ordered = table ? table.rank(peers, maxPeers) : peers.slice(0, maxPeers)

  if (concurrency <= 1) {
    for (const peer of ordered) {
      const r = await fetchMetadata(infoHash, peer, timeoutMs, connectTimeoutMs)

      if (r.ok) {
        table?.succeeded(peer, r.connectMs)
        return r
      }
      table?.failed(peer, { connected: r.connected })
    }
    return null
  }

  // A few at a time, for the latency-sensitive caller.
  //
  // Sequential is right for the crawler: it has thousands of hashes in
  // flight, so per-hash latency is irrelevant and extra connections to a
  // dead swarm are pure waste. It is wrong behind a request. Cold, with an
  // empty table, DHT peers measured 13% TCP-connect, so the expected walk to
  // the first live one is ~8 addresses at their connect deadline apiece —
  // and a *healthy, streamable* torrent came back unverified after 20s
  // because of it. Wrong answer, slowly.
  //
  // A small pool fixes the tail without becoming a broadcast: the ceiling on
  // wasted connections is `concurrency`, not the whole peer list, and the
  // first success stops the rest from starting.
  let next = 0
  let winner = null

  const worker = async () => {
    while (winner === null && next < ordered.length) {
      const peer = ordered[next++]
      const r = await fetchMetadata(infoHash, peer, timeoutMs, connectTimeoutMs)
      if (winner !== null) return
      if (r.ok) {
        table?.succeeded(peer, r.connectMs)
        winner = r
        return
      }
      table?.failed(peer, { connected: r.connected })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ordered.length) }, worker)
  )
  return winner
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS }

export default fetchMetadata
