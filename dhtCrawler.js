'use strict'

import crypto from 'crypto'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

import { fetchFromAny } from './metainfo.js'
import PeerTable from './peerTable.js'
import ContentFilter from './contentFilter.js'

/**
 * DHT infohash crawler (BEP 51).
 *
 * The DHT is a hash table, not a search engine: `get_peers` answers "who has
 * this infohash", and there is no way to ask "what is called The Walking
 * Dead". BEP 51 adds `sample_infohashes`, which asks a node for a random
 * sample of the infohashes it currently knows about. Fetch metadata for each
 * (BEP 9) and you learn the name — and doing that continuously builds an
 * index of the network from the network itself, with no website in the loop.
 *
 * The honest shape of this: it is *harvesting*, not searching. You take
 * whatever floats past your node. Coverage grows over hours and days, it
 * skews toward what is announced most often, and there is no guarantee any
 * particular title ever appears.
 *
 * ---------------------------------------------------------------------
 * Three stages, not two
 * ---------------------------------------------------------------------
 *
 *   sample   ask a node for infohashes it knows        (UDP, BEP 51)
 *   peers    ask THAT node who has one of them         (UDP, get_peers)
 *   name     ask those peers for the metadata          (TCP, BEP 9)
 *
 * The middle stage is the one this originally lacked, and its absence was
 * the whole problem. A bare infohash handed to a torrent client is a request
 * to go find the swarm from nothing. But the node that just told us about a
 * hash is, by definition, a node holding peers for it — the best lead
 * available, and free, because it is one more UDP round trip to an address
 * already in hand. Discarding that association and rediscovering the swarm
 * from scratch is what limited naming to ~10 attempts a minute.
 *
 * Measured against the previous design, same machine, same network: see the
 * README's crawler section.
 */

/** BEP 51 default when a node omits `interval`. */
const SAMPLE_INTERVAL_FALLBACK_S = 21600

/**
 * Most nodes ask for a six-hour backoff, which would make a keyspace sweep
 * take days. A node that is still handing us hashes we have not seen is
 * worth revisiting sooner than that; one that is not, we honour in full.
 */
const BUSY_NODE_INTERVAL_S = 60
const INTERVAL_HONOUR_THRESHOLD_S = 300

const NODE_QUEUE_MAX = 20000
const LEAD_QUEUE_MAX = 5000
const META_QUEUE_MAX = 2000

/**
 * Deadline for one DHT query.
 *
 * Left at 3s despite a KRPC query being a single UDP round trip that live
 * nodes answer in tens of milliseconds. Cutting it to 1.5s *while* raising
 * sampling concurrency to 150 was measured and it collapsed the crawl:
 * every query began timing out, sampling froze at 1,060 and the peer stage
 * returned 0 hits from 1,048 attempts, while the node counter kept climbing
 * because failures still count as visits.
 *
 * Two variables moved at once there, so the timeout is not proven guilty —
 * but the pair is, and the shared DHT socket is the reason to suspect
 * saturation rather than impatience: sampling and peer lookup both run
 * through the one KRPC transport that swarmScout is also using. Retune one
 * variable at a time against tools/peer-yield.mjs before trusting a change
 * here.
 */
const QUERY_TIMEOUT_MS = 3000
const METADATA_TIMEOUT_MS = 6000

/**
 * Peers to try per hash before giving up on it for now.
 *
 * Raised from 4 once the connect deadline made a dead peer cheap. Measured,
 * only ~13% of peer addresses from the DHT accept a connection at all — the
 * rest are stale or firewalled — so the chance of a hash resolving is
 * governed by how many addresses get tried:
 *
 *   4 peers  →  1 - 0.87^4  ≈ 44%
 *   8 peers  →  1 - 0.87^8  ≈ 69%
 *
 * Under the old flat 6s budget, eight peers would have been a 48s worst case
 * per hash and unthinkable. At 1.2s per dead connect it is ~10s, and buys
 * half again as many names.
 */
const PEERS_PER_HASH = 8

export class DhtCrawler {
  /**
   * @param {object} opts
   * @param {DHT}    opts.dht    a live bittorrent-dht instance
   * @param {string} [opts.file] sqlite path
   */
  constructor (opts = {}) {
    const {
    dht,
    file = path.join(process.cwd(), '.dht-index.db'),
    // These three are not independent: the first two share one KRPC socket
    // with swarmScout, so widening them competes for the same transport,
    // while the naming stage holds its own TCP connections and scales on its
    // own. 150/150 was tried and saturated the socket — see
    // QUERY_TIMEOUT_MS. This set is the one that measured.
    sampleConcurrency = 40,
    peerConcurrency = 100,
    // Raised from 100 once the queue instrumentation showed this stage was
    // the binding constraint on the whole crawl. These are outbound TCP
    // connections, not KRPC queries, so they are bounded by the OS and the
    // network rather than by DHT_CONCURRENCY — a different budget entirely.
    metadataConcurrency = 300,
    discoveryConcurrency = 20
    } = opts
    if (!dht) throw new Error('DhtCrawler needs a DHT instance')
    this.dht = dht
    this.sampleConcurrency = sampleConcurrency
    this.discoveryConcurrency = discoveryConcurrency
    this.peerConcurrency = peerConcurrency
    this.metadataConcurrency = metadataConcurrency

    this.running = false

    /** Nodes to ask for samples. */
    this.queue = []
    /** Nodes to ask for neighbours — see _discoveryWorker. */
    this.discoveryQueue = []
    /** {hash, node} — a hash, and a node known to hold peers for it. */
    this.leads = []
    /** {hash, peers} — ready for the naming stage. */
    this.pendingMeta = []

    /**
     * What we know about peer addresses, across every hash.
     *
     * The crawl's one genuinely reusable asset. See peerTable.js — the
     * short version is that ~87% of addresses the DHT offers never accept a
     * connection, the same addresses recur constantly across hashes, and
     * re-paying the connect timeout to rediscover that costs more than
     * everything else in this stage combined.
     */
    this.peerTable = opts.peerTable || new PeerTable()

    /**
     * Gate on persistence. An unfiltered BEP 51 crawl indexes whatever the
     * network holds, which within minutes included material this project
     * will not store. Constructed eagerly so a missing or malformed ruleset
     * fails at startup rather than silently passing everything through.
     */
    this.filter = opts.filter || new ContentFilter()

    /**
     * Per-node state: whether it answers BEP 51 at all, and when it is
     * willing to be asked again. Most DHT nodes do not implement
     * sample_infohashes — measured at ~44% of queries erroring — so
     * remembering which ones do turns a coin flip into a hit.
     */
    this.nodes = new Map()

    this.stats = {
      queried: 0,
      sampled: 0,
      stored: 0,
      leads: 0,
      peerHits: 0,
      peerMisses: 0,
      metaAttempts: 0,
      named: 0,
      // Hashes that had live peers but never got tried. Should be 0; a
      // nonzero value means the naming stage is falling behind badly
      // enough that backpressure alone cannot hold the line.
      dropped: 0,
      // Matched the content filter and was discarded rather than named.
      blocked: 0,
      errors: 0,
      findNode: 0,
      discovered: 0
    }

    /** Counter behind the keyspace sweep; see _nextTarget. */
    this._sweep = 0

    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS torrents (
        info_hash  TEXT PRIMARY KEY,
        name       TEXT,
        size       INTEGER,
        files      INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 1,
        resolved   INTEGER NOT NULL DEFAULT 0,
        failed     INTEGER NOT NULL DEFAULT 0,
        -- Matched the content filter. Such a row keeps its infohash so the
        -- crawl does not rediscover and re-fetch it, but never its name:
        -- there is nothing to leak through a query that forgets a WHERE.
        blocked    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_unresolved ON torrents (resolved, failed, hits DESC);
      CREATE INDEX IF NOT EXISTS idx_name ON torrents (name);
    `)

    // Existing indexes predate the filter. ALTER TABLE ADD COLUMN is cheap
    // and idempotent-by-catch; the alternative is every older database
    // failing on first write.
    try { this.db.exec('ALTER TABLE torrents ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0') } catch { /* already there */ }

    // RETURNING gives the post-update hit count from the write we already
    // perform, so corroboration costs no extra query — a separate SELECT
    // per sampled hash would have been ~4µs × the full sample rate for
    // information this statement already has in hand.
    this._seen = this.db.prepare(`
      INSERT INTO torrents (info_hash, first_seen, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(info_hash) DO UPDATE SET last_seen = excluded.last_seen, hits = hits + 1
      RETURNING hits`)
    this._name = this.db.prepare(
      'UPDATE torrents SET name = ?, size = ?, files = ?, resolved = 1 WHERE info_hash = ?')
    this._fail = this.db.prepare('UPDATE torrents SET failed = failed + 1 WHERE info_hash = ?')
    // Blocked rows are marked resolved so the naming stage never retries
    // them, and failed high so no backlog pass picks them up either. The
    // name column is left NULL on purpose.
    this._block = this.db.prepare(
      'UPDATE torrents SET blocked = 1, resolved = 1, name = NULL WHERE info_hash = ?')
    this._isNamed = this.db.prepare('SELECT resolved FROM torrents WHERE info_hash = ?')
    /**
     * Backlog, ordered by corroboration.
     *
     * `hits` counts how many independent nodes offered the same hash, which
     * is the best available proxy for a swarm being alive — a hash six nodes
     * know about is a far better bet than one seen once. Spending a fixed
     * attempt budget on the most-corroborated hashes first is free accuracy.
     */
    this._pending = this.db.prepare(`
      SELECT info_hash FROM torrents
      WHERE resolved = 0 AND failed < 3
      ORDER BY hits DESC, last_seen DESC LIMIT ?`)
    this._counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN resolved = 1 AND blocked = 0 THEN 1 ELSE 0 END) AS named,
             SUM(blocked) AS blocked,
             SUM(CASE WHEN resolved = 0 AND failed < 3 THEN 1 ELSE 0 END) AS pending
      FROM torrents`)
  }

  /* ------------------------------------------------------------------ *
   * Keyspace
   * ------------------------------------------------------------------ */

  /**
   * The next `target` to sample against.
   *
   * BEP 51 expects an indexer to cover the ring by "adjusting the target
   * value for each RPC" — a sweep, not random darts. Random targets clump
   * and leave gaps; a bit-reversed counter in the high bits visits the space
   * in maximally-spread order, so coverage is even at every point in the
   * crawl rather than only once it has run long enough to average out.
   */
  _nextTarget () {
    const n = this._sweep++
    let reversed = 0
    for (let i = 0; i < 32; i++) reversed = (reversed << 1) | ((n >>> i) & 1)
    const target = crypto.randomBytes(20)
    target.writeUInt32BE(reversed >>> 0, 0)
    return target
  }

  /* ------------------------------------------------------------------ *
   * Node bookkeeping
   * ------------------------------------------------------------------ */

  _nodeKey (node) {
    return `${node.host}:${node.port}`
  }

  _nodeState (node) {
    const key = this._nodeKey(node)
    let state = this.nodes.get(key)
    if (!state) {
      state = { supports: null, nextAt: 0, failures: 0 }
      // Bounded: a long crawl meets far more nodes than it can remember,
      // and the table is an optimisation rather than a source of truth.
      if (this.nodes.size > NODE_QUEUE_MAX * 2) this.nodes.clear()
      this.nodes.set(key, state)
    }
    return state
  }

  _enqueueNodes (nodes) {
    const now = Date.now()
    for (const node of nodes) {
      if (!node?.host || !node.port) continue
      const state = this._nodeState(node)
      if (state.supports === false) continue      // does not speak BEP 51
      if (state.nextAt > now) continue            // asked too recently
      if (this.queue.length >= NODE_QUEUE_MAX) return
      this.queue.push(node)
    }
  }

  /**
   * Normalise a bencoded byte string.
   *
   * Never test these with `Buffer.isBuffer`. The decoder hands back a real
   * Buffer for a top-level byte string but not necessarily for one nested
   * inside a list — `values` is a *list* of 6-byte strings — and since
   * Buffer is a Uint8Array subclass, the check fails one way round while
   * every read on the object would have worked. A decoder that silently
   * returns nothing is the worst possible failure here: it looks exactly
   * like a swarm with no peers, which is also the common legitimate case.
   */
  _bytes (value) {
    if (Buffer.isBuffer(value)) return value
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer) return Buffer.from(value)
    return null
  }

  /** Compact node info: 26 bytes each — 20 id, 4 IPv4, 2 port. */
  _decodeNodes (raw) {
    const out = []
    const buf = this._bytes(raw)
    if (!buf) return out
    for (let i = 0; i + 26 <= buf.length; i += 26) {
      const host = `${buf[i + 20]}.${buf[i + 21]}.${buf[i + 22]}.${buf[i + 23]}`
      const port = buf.readUInt16BE(i + 24)
      if (port > 0 && port < 65536) out.push({ host, port })
    }
    return out
  }

  /** Compact peer info: 6 bytes each — 4 IPv4, 2 port. */
  _decodePeers (values) {
    const out = []
    if (!Array.isArray(values)) return out
    for (const v of values) {
      const buf = this._bytes(v)
      if (!buf || buf.length !== 6) continue
      const port = buf.readUInt16BE(4)
      // Port 0 is a peer that cannot accept connections.
      if (port > 0) out.push({ host: `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`, port })
    }
    return out
  }

  /* ------------------------------------------------------------------ *
   * Raw queries
   *
   * Neither of these is in bittorrent-dht's API, but the underlying KRPC
   * transport will send any query, so the messages are built by hand.
   * ------------------------------------------------------------------ */

  _query (node, message) {
    return new Promise(resolve => {
      let done = false
      const finish = value => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), QUERY_TIMEOUT_MS)

      try {
        this.dht._rpc.query(node, message, (err, res) => {
          if (err || !res?.r) return finish(null)
          finish(res.r)
        })
      } catch {
        finish(null)
      }
    })
  }

  _sample (node) {
    return this._query(node, {
      q: 'sample_infohashes',
      a: { id: this.dht.nodeId, target: this._nextTarget() }
    })
  }

  /**
   * Ask a node for the nodes it knows near a target.
   *
   * This is the crawl's supply of fresh addresses, and without it the whole
   * thing starves. Sampling consumes nodes permanently — one that answers is
   * backed off for its requested interval, one that does not is written off
   * as not implementing BEP 51 — so a crawl whose only source of new nodes
   * is `sample_infohashes` replies runs dry the moment it exhausts the
   * neighbourhood it started in. Measured: sampling froze at 780 hashes
   * after ninety seconds and never recovered.
   *
   * find_node is answered by *every* DHT node, including the majority that
   * ignore BEP 51, which is what makes it a supply rather than another
   * filter.
   */
  _findNode (node) {
    return this._query(node, {
      q: 'find_node',
      a: { id: this.dht.nodeId, target: this._nextTarget() }
    })
  }

  _getPeers (node, infoHashHex) {
    return this._query(node, {
      q: 'get_peers',
      a: { id: this.dht.nodeId, info_hash: Buffer.from(infoHashHex, 'hex') }
    })
  }

  /* ------------------------------------------------------------------ *
   * Stage 1 — sampling
   * ------------------------------------------------------------------ */

  async _sampleWorker () {
    while (this.running) {
      const node = this.queue.shift()
      if (!node) {
        this._reseed()
        if (!this.queue.length) await this._pause(500)
        continue
      }

      const state = this._nodeState(node)
      this.stats.queried++
      const r = await this._sample(node)

      if (!r) {
        this.stats.errors++
        state.failures++
        // Two strikes and the node is written off. Most of the DHT does not
        // implement BEP 51, and re-asking those forever is the difference
        // between a 44% error rate and a working crawl.
        if (state.failures >= 2) state.supports = false
        continue
      }

      state.supports = true
      state.failures = 0

      let fresh = 0
      const samples = this._bytes(r.samples)
      if (samples) {
        const now = Date.now()
        for (let i = 0; i + 20 <= samples.length; i += 20) {
          const hash = samples.subarray(i, i + 20).toString('hex')
          this.stats.sampled++
          let hits = 1
          try {
            hits = this._seen.get(hash, now, now)?.hits ?? 1
            this.stats.stored++
          } catch { /* a duplicate is the normal case */ }

          // Already named — no need to chase it again.
          if (this._isNamed.get(hash)?.resolved) continue

          fresh++
          // The lead: this node answered for this hash, so it is the
          // cheapest place to ask who has it.
          // Corroboration decides position in the queue, not arrival order.
          //
          // `hits` counts how many *independent* nodes have offered this
          // hash. It is the best proxy available for a swarm being alive:
          // a hash six nodes are storing is far more likely to have a
          // reachable peer than one seen once, and the naming stage cannot
          // keep up with the peer stage regardless — so the queue order
          // decides which hashes get the budget and which quietly age out.
          // Spending the same number of connections on better-corroborated
          // targets is free conversion.
          //
          // A plain unshift for repeats is enough: it is O(1), it keeps
          // arrival order within each class, and it avoids sorting a
          // five-thousand-entry queue on every sample. bitmagnet tracks the
          // same association and does not use it this way.
          if (this.leads.length < LEAD_QUEUE_MAX) {
            const corroborated = hits > 1
            if (corroborated) this.leads.unshift({ hash, node })
            else this.leads.push({ hash, node })
            this.stats.leads++
          }
        }
      }

      // Honour the node's requested interval, except when it is still
      // producing — see BUSY_NODE_INTERVAL_S.
      let interval = Number(r.interval) || SAMPLE_INTERVAL_FALLBACK_S
      if (fresh > 0 && interval > INTERVAL_HONOUR_THRESHOLD_S) {
        interval = BUSY_NODE_INTERVAL_S
      }
      state.nextAt = Date.now() + interval * 1000

      // Every reply also carries neighbours, which is how the crawl spreads.
      this._enqueueNodes(this._decodeNodes(r.nodes))
    }
  }

  /* ------------------------------------------------------------------ *
   * Stage 0 — keep finding nodes
   * ------------------------------------------------------------------ */

  /**
   * Walk the keyspace asking for neighbours, purely to keep the sampler fed.
   *
   * Runs off its own queue so that discovery cannot be starved by sampling
   * or starve it in turn: a node is worth asking for neighbours exactly once,
   * whereas a BEP 51 node is worth resampling on its interval, and mixing
   * the two lifetimes in one queue is what let the crawl stall.
   */
  async _discoveryWorker () {
    while (this.running) {
      const node = this.discoveryQueue.shift()
      if (!node) {
        // Seed from wherever addresses can still be found: the live routing
        // table, then anything queued for sampling.
        let seed = []
        try { seed = this.dht.toJSON().nodes || [] } catch { /* mid-teardown */ }
        for (const n of seed.concat(this.queue.slice(0, 200))) {
          if (this.discoveryQueue.length < NODE_QUEUE_MAX) this.discoveryQueue.push(n)
        }
        if (!this.discoveryQueue.length) await this._pause(1000)
        continue
      }

      this.stats.findNode++
      const r = await this._findNode(node)
      if (!r) continue

      const found = this._decodeNodes(r.nodes)
      this.stats.discovered += found.length

      // Fresh addresses feed both queues: unknown nodes might speak BEP 51,
      // and they can certainly be asked for more neighbours.
      this._enqueueNodes(found)
      for (const n of found) {
        if (this.discoveryQueue.length < NODE_QUEUE_MAX) this.discoveryQueue.push(n)
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Stage 2 — who has it
   * ------------------------------------------------------------------ */

  async _peerWorker () {
    while (this.running) {
      const lead = this.leads.shift()
      if (!lead) { await this._pause(250); continue }

      const r = await this._getPeers(lead.node, lead.hash)
      const peers = this._decodePeers(r?.values)

      if (!peers.length) {
        // The node knew the hash but holds no peers for it. That is the
        // common case for a dead swarm, and it is a *cheap* no — one UDP
        // round trip, rather than a TCP connection budget spent finding out.
        this.stats.peerMisses++
        this._fail.run(lead.hash)
        continue
      }

      this.stats.peerHits++
      // Register the addresses even before trying them, so the table's
      // notion of "seen" covers the whole population rather than only the
      // ones that reached the naming stage.
      this.peerTable.observe(peers)

      // Backpressure, not a silent drop.
      //
      // This queue used to be a bounded push that discarded the overflow
      // without counting it, and the overflow was not marginal: the naming
      // stage consumes roughly 10 hashes/s while this stage produces ~63/s,
      // so a measured 7,583 hashes that *had live peers* — the expensive,
      // hard-won ones — were thrown away in a five-minute run.
      //
      // Waiting instead of dropping does not by itself make naming faster,
      // but it stops this stage burning `get_peers` round trips on work
      // that will be binned, and it makes the imbalance visible rather than
      // silent. `dropped` should stay at zero now; if it climbs, the wait
      // below is being defeated by a stall downstream.
      while (this.running && this.pendingMeta.length >= META_QUEUE_MAX) {
        await this._pause(100)
      }
      if (!this.running) return
      if (this.pendingMeta.length < META_QUEUE_MAX) {
        this.pendingMeta.push({ hash: lead.hash, peers })
      } else {
        this.stats.dropped++
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Stage 3 — naming
   * ------------------------------------------------------------------ */

  async _metaWorker () {
    while (this.running) {
      const job = this.pendingMeta.shift()
      if (!job) { await this._pause(250); continue }

      this.stats.metaAttempts++
      const meta = await fetchFromAny(job.hash, job.peers, {
        timeoutMs: METADATA_TIMEOUT_MS,
        maxPeers: PEERS_PER_HASH,
        table: this.peerTable
      })

      if (meta?.name) {
        // The gate. Nothing that matches is written, so there is no row to
        // leak through a query that forgets its WHERE clause, and no name in
        // the database at all. See contentFilter.js for why this is not
        // optional for a BEP 51 crawler.
        const verdict = this.filter.check(meta)
        if (verdict.blocked) {
          this._block.run(job.hash)
          this.stats.blocked++
        } else {
          this._name.run(meta.name, meta.size || 0, meta.files || 0, job.hash)
          this.stats.named++
        }
      } else {
        this._fail.run(job.hash)
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Why there is no backlog stage
   * ------------------------------------------------------------------ *
   *
   * The index carries tens of thousands of hashes harvested before the
   * peer stage existed, none of which have a node association. The only way
   * to find peers for those is a full iterative lookup, and that was
   * measured against the direct method on the same 60 hashes
   * (tools/peer-yield.mjs):
   *
   *   direct get_peers to the sampling node   38.3% hit, 298ms for 60
   *   full iterative DHT lookup                5.0% hit, 6,013ms for 60
   *
   * Twenty times the cost for an eighth of the yield, and it found nothing
   * the direct method missed. Rediscovery is the better answer: the DHT
   * keeps re-announcing live swarms, so a hash worth naming comes back
   * around with a node attached, and one that never comes back was dead.
   */

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  _pause (ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  /**
   * Keep the queue fed from the routing table.
   *
   * A cold client starts with a nearly empty table and the crawl cannot
   * spread from nothing. The DHT keeps populating itself in the background,
   * so re-reading it periodically turns a slow start into a self-correcting
   * one.
   */
  _reseed () {
    let nodes = []
    try { nodes = this.dht.toJSON().nodes || [] } catch { /* mid-teardown */ }
    this._enqueueNodes(nodes)
    return nodes.length
  }

  start () {
    if (this.running) return
    this.running = true
    this._reseed()

    for (let i = 0; i < this.discoveryConcurrency; i++) this._discoveryWorker()
    for (let i = 0; i < this.sampleConcurrency; i++) this._sampleWorker()
    for (let i = 0; i < this.peerConcurrency; i++) this._peerWorker()
    for (let i = 0; i < this.metadataConcurrency; i++) this._metaWorker()

    this._reseedTimer = setInterval(() => {
      if (this.queue.length < this.sampleConcurrency * 4) this._reseed()
    }, 5000)

    console.log(`[crawler] started — ${this.discoveryConcurrency} finders, ` +
      `${this.sampleConcurrency} samplers, ${this.peerConcurrency} peer lookups, ` +
      `${this.metadataConcurrency} metadata fetchers`)
  }

  stop () {
    this.running = false
    clearInterval(this._reseedTimer)
  }

  /* ------------------------------------------------------------------ *
   * Reading
   * ------------------------------------------------------------------ */

  counts () {
    const r = this._counts.get()
    return {
      total: r.total || 0,
      // `named` excludes blocked rows, so every counter and every benchmark
      // reports the size of the index a user could actually search.
      named: r.named || 0,
      blocked: r.blocked || 0,
      pending: r.pending || 0
    }
  }

  /**
   * Search names the crawler has resolved.
   *
   * Every term must appear, so "walking dead" does not match everything
   * containing "dead". This is a LIKE scan rather than full-text search:
   * simple, and adequate until the index is large enough to need FTS5.
   */
  search (query, limit = 40) {
    const terms = String(query || '')
      .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    if (!terms.length) return []

    const where = terms.map(() => 'LOWER(name) LIKE ?').join(' AND ')
    const stmt = this.db.prepare(
      `SELECT info_hash, name, size, files, hits FROM torrents
       WHERE resolved = 1 AND blocked = 0 AND name IS NOT NULL AND ${where}
       ORDER BY hits DESC LIMIT ?`)
    return stmt.all(...terms.map(t => `%${t}%`), limit)
      .map(r => ({
        infoHash: r.info_hash, title: r.name, size: r.size, files: r.files, hits: r.hits
      }))
  }

  close () {
    this.stop()
    try { this.db.close() } catch { /* already closed */ }
  }
}

export default DhtCrawler
