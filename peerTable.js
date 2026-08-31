'use strict'

/**
 * What we know about peer addresses, across every hash we have seen.
 *
 * This is the piece bitmagnet has and an obvious crawler does not. Its
 * `ktable` keeps two keyspaces — nodes and hashes — plus a *reverse map*
 * from address to the set of hashes that address serves. The naive design
 * (ours, until now) asks `get_peers` for a hash, tries the addresses it gets
 * back, and throws all of it away. The next hash starts from nothing, even
 * when it returns the very same addresses.
 *
 * Why that is expensive: measured, **only ~13% of addresses the DHT hands
 * back accept a TCP connection at all** — the rest are stale records or
 * firewalled clients. Each of those costs a full connect timeout to discover.
 * And the same addresses recur constantly, because a well-connected client
 * seeding many torrents appears in many peer lists. Re-paying 1.2s to
 * rediscover that 78.94.x.x is unreachable, once per hash, is most of the
 * naming stage's budget.
 *
 * ---------------------------------------------------------------------
 * What is and is not reusable
 * ---------------------------------------------------------------------
 *
 * A tempting misreading of "reuse peers" is to try a known-good address for
 * a hash it was never associated with. That does not work: a peer serves
 * metadata only for torrents it actually holds, so the ut_metadata exchange
 * fails and you have spent a connection to learn nothing.
 *
 * What transfers across hashes is **liveness and quality of the address
 * itself**:
 *
 *   known dead   skip instantly, 0ms instead of a 1.2s connect timeout
 *   known good   try first, because it answered before
 *   unknown      try after the known-good ones
 *
 * The hash association is still needed to decide *which* addresses are
 * candidates at all — that comes from get_peers, as before. This table only
 * reorders and prunes that candidate list.
 *
 * One thing this does that bitmagnet does not: it keeps the measured connect
 * RTT per address, so ordering is by observed latency rather than merely by
 * "responded once". See locality.js for the same idea applied to ranking.
 */

/** Failed connects before an address is treated as dead. */
const DEAD_AFTER_FAILURES = 2

/**
 * How long a dead verdict stands.
 *
 * Not forever: addresses are recycled, clients come back online, and a
 * permanently poisoned entry would slowly starve the crawl of candidates.
 * Long enough that we are not re-testing the same dead host every minute.
 */
const DEAD_TTL_MS = 30 * 60 * 1000

/** Bound on the table, evicted oldest-first. */
const MAX_ADDRS = 200_000

export class PeerTable {
  constructor ({ maxAddrs = MAX_ADDRS, deadAfter = DEAD_AFTER_FAILURES, deadTtlMs = DEAD_TTL_MS } = {}) {
    this.maxAddrs = maxAddrs
    this.deadAfter = deadAfter
    this.deadTtlMs = deadTtlMs

    /** `host:port` -> { ok, fail, lastOk, lastFail, rtt, seen } */
    this.addrs = new Map()

    this.stats = { hits: 0, skipped: 0, promoted: 0, evicted: 0 }
  }

  _key (peer) {
    return `${peer.host}:${peer.port}`
  }

  _entry (key) {
    let e = this.addrs.get(key)
    if (!e) {
      if (this.addrs.size >= this.maxAddrs) this._evict()
      e = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, rtt: null, seen: Date.now() }
      this.addrs.set(key, e)
    }
    return e
  }

  /**
   * Drop the oldest tenth rather than one entry per insert.
   *
   * Map preserves insertion order, so the first keys are the least recently
   * *created*. Evicting in a batch keeps this off the hot path — one sweep
   * per twenty thousand inserts instead of a delete on every one.
   */
  _evict () {
    const target = Math.max(1, Math.floor(this.maxAddrs / 10))
    let n = 0
    for (const key of this.addrs.keys()) {
      this.addrs.delete(key)
      if (++n >= target) break
    }
    this.stats.evicted += n
  }

  /** An address answered a metadata request. `rtt` is its connect time. */
  succeeded (peer, rtt = null) {
    const e = this._entry(this._key(peer))
    e.ok++
    e.lastOk = Date.now()
    // Keep the best observed connect time: a single slow sample on a
    // congested moment should not demote an otherwise good address.
    if (rtt !== null && (e.rtt === null || rtt < e.rtt)) e.rtt = rtt
  }

  /**
   * An address did not yield metadata.
   *
   * `connected` distinguishes the two failures, and they mean opposite
   * things. A peer that completed a TCP handshake and then did not serve
   * the metadata is *alive* — it simply does not hold this torrent, or does
   * not speak the extension. Marking it dead would throw away a good
   * address. Only a failure to connect counts against liveness.
   */
  failed (peer, { connected = false } = {}) {
    const e = this._entry(this._key(peer))
    if (connected) {
      e.lastOk = Date.now()
      return
    }
    e.fail++
    e.lastFail = Date.now()
  }

  /** True when this address has failed enough, recently enough, to skip. */
  isDead (key) {
    const e = this.addrs.get(key)
    if (!e || e.ok > 0) return false
    if (e.fail < this.deadAfter) return false
    return Date.now() - e.lastFail < this.deadTtlMs
  }

  /**
   * Order a candidate list, dropping addresses known to be dead.
   *
   * Returns at most `limit` addresses: known-good first (fastest connect
   * first), then unknown. The point is that the caller tries them in order
   * and stops at the first success, so putting a previously-answering
   * address in front converts a hash on the first connection instead of the
   * fifth.
   */
  rank (peers, limit = 8) {
    const good = []
    const unknown = []

    for (const peer of peers) {
      const key = this._key(peer)
      if (this.isDead(key)) { this.stats.skipped++; continue }
      const e = this.addrs.get(key)
      if (e?.ok > 0) { good.push({ peer, rtt: e.rtt ?? Infinity }); this.stats.hits++ } else unknown.push(peer)
    }

    good.sort((a, b) => a.rtt - b.rtt)
    if (good.length) this.stats.promoted++

    return [...good.map(g => g.peer), ...unknown].slice(0, limit)
  }

  /** Record that these addresses were offered for some hash. */
  observe (peers) {
    for (const peer of peers) this._entry(this._key(peer))
  }

  summary () {
    let alive = 0
    let dead = 0
    for (const [key, e] of this.addrs) {
      if (e.ok > 0) alive++
      else if (this.isDead(key)) dead++
    }
    return { tracked: this.addrs.size, alive, dead, ...this.stats }
  }
}

export default PeerTable
