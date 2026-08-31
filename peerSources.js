'use strict'

import net from 'net'
import crypto from 'crypto'

/**
 * Where live peers come from.
 *
 * Both implementations expose the same thing SwarmScout actually needs — a
 * bounded-window peer collector:
 *
 *     sample(infoHash, windowMs) -> Promise<Array<{host, port, rttMs?}>>
 *
 * Only the transport differs, which is the point: swapping the discovery
 * mechanism must not disturb ranking, caching or failover.
 *
 *   DhtPeerSource     BEP 5 `get_peers` against the public DHT. Correct on
 *                     the open internet, where you have no idea who else is
 *                     in the swarm and have to ask.
 *
 *   DirectPeerSource  connect-and-handshake against K random members of a
 *                     known roster. Correct on a private network, where the
 *                     membership is already known and the DHT is answering a
 *                     question nobody asked — it costs a UDP round trip to
 *                     the public internet to discover hosts you could have
 *                     simply tried.
 *
 * The direct source also returns something the DHT cannot: a measured RTT
 * per peer, which is exactly the signal locality.js needs to prefer a peer
 * in your rack over twenty in another region.
 */

const PROTOCOL = 'BitTorrent protocol'
const HANDSHAKE_LEN = 68
const DEFAULT_SAMPLE_K = 8
const CONNECT_TIMEOUT_MS = 800

/** BEP 3 handshake: pstrlen, pstr, 8 reserved, 20 infohash, 20 peer id. */
function buildHandshake (infoHash, peerId) {
  const buf = Buffer.alloc(HANDSHAKE_LEN)
  buf.writeUInt8(PROTOCOL.length, 0)
  buf.write(PROTOCOL, 1)
  buf.fill(0, 20, 28)
  Buffer.from(infoHash, 'hex').copy(buf, 28)
  peerId.copy(buf, 48)
  return buf
}

export class DhtPeerSource {
  constructor (dht) {
    this.dht = dht
    this.name = 'dht'
  }

  /**
   * Fire a lookup and collect whatever answers inside the window. Peers
   * carry no RTT: the DHT reports addresses it was told about, not hosts it
   * measured, so locality falls back to address inference.
   */
  sample (infoHash, windowMs) {
    return new Promise(resolve => {
      const found = []
      const target = infoHash.toLowerCase()
      const onPeer = (peer, hash) => {
        if (hash.toString('hex') === target) found.push({ host: peer.host, port: peer.port })
      }

      this.dht.on('peer', onPeer)
      try {
        this.dht.lookup(infoHash)
      } catch {
        this.dht.removeListener('peer', onPeer)
        return resolve([])
      }

      setTimeout(() => {
        this.dht.removeListener('peer', onPeer)
        resolve(found)
      }, windowMs)
    })
  }

  destroy () { /* the DHT instance is owned by SwarmScout */ }
}

export class DirectPeerSource {
  /**
   * @param {object} opts
   * @param {Array<{host,port}|string>} opts.members - the roster to sample from
   * @param {number} [opts.k] - how many members to probe per candidate
   */
  constructor ({ members = [], k = DEFAULT_SAMPLE_K } = {}) {
    this.name = 'direct'
    this.k = k
    this.peerId = Buffer.concat([
      Buffer.from('-SS0001-'),
      crypto.randomBytes(12)
    ])

    this.members = members.map(m => {
      if (typeof m !== 'string') return { host: m.host, port: Number(m.port) }
      const i = m.lastIndexOf(':')
      return { host: m.slice(0, i), port: Number(m.slice(i + 1)) }
    }).filter(m => m.host && Number.isInteger(m.port))
  }

  /** Sample without replacement, so one probe never tries the same host twice. */
  _pick (n) {
    const pool = this.members.slice()
    const out = []
    while (pool.length && out.length < n) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    }
    return out
  }

  /**
   * Does this member actually serve this infohash, and how far away is it?
   *
   * A completed handshake is a far stronger liveness signal than a DHT hit:
   * the DHT tells you someone once announced the infohash, while this proves
   * the host is up, listening, and holding that exact torrent right now.
   */
  _probe (member, infoHash, deadline) {
    return new Promise(resolve => {
      const started = Date.now()
      const budget = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline - started))
      const socket = new net.Socket()
      let settled = false
      let timer = null

      const done = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(result)
      }

      // A hard deadline, not just a socket idle timeout.
      //
      // `setTimeout` on a socket fires on inactivity, and a socket that has
      // been closed is not inactive — it is finished. A peer that hangs up
      // without sending anything (which is exactly what a peer serving a
      // different torrent does) therefore produced neither 'timeout' nor
      // 'error', and the probe never settled: sample() hung forever and
      // took the whole ranking pass with it.
      timer = setTimeout(() => done(null), budget)

      socket.setTimeout(budget)
      socket.once('timeout', () => done(null))
      socket.once('error', () => done(null))
      // Any orderly shutdown before a full handshake is a failed probe.
      socket.once('close', () => done(null))
      socket.once('end', () => done(null))

      socket.connect(member.port, member.host, () => {
        socket.write(buildHandshake(infoHash, this.peerId))
      })

      const chunks = []
      let received = 0
      socket.on('data', chunk => {
        chunks.push(chunk)
        received += chunk.length
        if (received < HANDSHAKE_LEN) return

        const reply = Buffer.concat(chunks)
        // Verify the peer answered for the infohash we asked about; a
        // multi-torrent seeder will happily accept the connection otherwise.
        const theirs = reply.subarray(28, 48).toString('hex')
        if (theirs !== infoHash.toLowerCase()) return done(null)

        done({ host: member.host, port: member.port, rttMs: Date.now() - started })
      })
    })
  }

  /**
   * Probe K random members in parallel and return those that answered,
   * within the same bounded window the DHT source honours.
   */
  async sample (infoHash, windowMs) {
    if (!this.members.length) return []
    const deadline = Date.now() + windowMs
    const picked = this._pick(this.k)

    const results = await Promise.all(
      picked.map(m => this._probe(m, infoHash, deadline).catch(() => null))
    )
    return results.filter(Boolean)
  }

  destroy () { /* sockets are closed per probe */ }
}

/**
 * Choose a source from configuration.
 *
 * `SWARM_SCOUT_MEMBERS=host:port,host:port` switches to direct probing;
 * absent, the DHT is used exactly as before.
 */
export function createPeerSource ({ dht, members, mode } = {}) {
  const roster = members?.length
    ? members
    : String(process.env.SWARM_SCOUT_MEMBERS || '').split(',').map(s => s.trim()).filter(Boolean)

  const wanted = mode || process.env.SWARM_SCOUT_MODE ||
    (roster.length ? 'fleet' : 'dht')

  if (wanted === 'fleet') {
    if (!roster.length) {
      console.warn('[scout] fleet mode requested with no members — falling back to the DHT')
    } else {
      console.log(`[scout] peer source: direct handshake against ${roster.length} known members`)
      return new DirectPeerSource({ members: roster })
    }
  }

  return new DhtPeerSource(dht)
}
