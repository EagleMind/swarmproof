'use strict'

import { Client as TrackerClient } from 'bittorrent-tracker'
import DHT from 'bittorrent-dht'
import PeerCache from './peerCache.js'
import CloudCache from './cloudCache.js'
import { createPeerSource } from './peerSources.js'
import { weightedPeerCount, meanLocality } from './locality.js'
import { fetchFromAny } from './metainfo.js'
import { PeerTable } from './peerTable.js'

/**
 * SwarmScout
 * ----------
 * Given several *candidate* sources for the same piece of content
 * (e.g. different releases/torrents an add-on found), figure out
 * which swarm is actually healthy enough to stream from, fast.
 *
 * Design goals for the MVP:
 *  - Never block on a single slow/dead tracker or a cold DHT lookup.
 *  - Score candidates on real signals (scrape counts, live DHT peer
 *    hits), not just "first to respond."
 *  - Cache good results so the second time someone plays the same
 *    content, discovery is near-instant.
 *  - Return a *ranked* list, not just a winner, so the caller can
 *    fail over without re-running discovery from scratch.
 */

const DEFAULT_BUDGET_MS = 1500 // hard ceiling per candidate probe
const SCRAPE_TIMEOUT_MS = 1200 // per-tracker ceiling (a hung tracker must not hold the probe)
const SCRAPE_GRACE_MS = 300    // after the first answer, how long to wait for a better one
const DHT_WINDOW_MS = 900      // how long to collect DHT peers once the lookup is fired
const DHT_BOOTSTRAP_TIMEOUT_MS = 15000
const MAX_CACHED_BOOTSTRAP = 50 // cached nodes to try before the public bootstrap domains
const MAX_SHARED_BOOTSTRAP = 50 // shared nodes to fold in on a cold start
const SHARED_HEALTH_MAX_AGE_MS = 600_000 // shared health older than this is re-probed

/**
 * In-flight KRPC queries allowed on the shared DHT socket.
 *
 * k-rpc's own default is 16. See the DHT construction in the constructor for
 * why that one number governs everything the crawler can do.
 */
const DHT_CONCURRENCY = 300

/**
 * Bootstrap nodes, measured live rather than copied from documentation.
 * As of the last check from this machine, only these two answer a KRPC
 * ping at all:
 *
 *   dht.libtorrent.org:25401     ALIVE 4/4  (best 59ms)
 *   dht.transmissionbt.com:6881  ALIVE 4/4  (best 49ms)
 *
 * Silent over repeated attempts, on both DNS name and hardcoded IP:
 *   router.bittorrent.com:6881   (67.215.246.10)  0/3
 *   router.utorrent.com:6881     (82.221.103.244) 0/3
 *   dht.aelitis.com:6881         (34.203.221.232) 0/4
 *   dht.bitcomet.com:6881        (no DNS record at all)
 *
 * They are kept as a trailing fallback in case they come back, but
 * nothing should depend on them: bittorrent-dht resolves and pings
 * bootstrap entries in parallel, so dead ones cost nothing beyond a few
 * wasted UDP packets.
 *
 * router.silotis.us is deliberately absent: it publishes an AAAA record
 * only (2600:1700:88b0:ab60::1) and no A record, so it is unreachable
 * from an IPv4-only DHT socket. Add it back if/when IPv6 DHT is enabled.
 */
const DEFAULT_DHT_BOOTSTRAP = [
  'dht.libtorrent.org:25401',
  'dht.transmissionbt.com:6881',
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881'
]

export default class SwarmScout {
  /**
   * @param {object} opts
   * @param {string[]} [opts.dhtBootstrap] - bootstrap nodes for the shared DHT instance
   * @param {number} [opts.probeBudgetMs] - max time to spend probing one candidate
   * @param {PeerCache} [opts.cache]
   */
  /**
   * Async construction, used when a shared control plane is configured.
   *
   * On a *truly cold* client (no local nodes on disk) it is worth briefly
   * waiting for shared nodes, because they can go into the bootstrap array
   * where they actually reduce time-to-ready. On a warm client we never
   * wait: local disk (~1ms) beats an edge round trip (~20-60ms), so the
   * shared nodes are folded in asynchronously instead.
   */
  static async create (opts = {}) {
    const cache = opts.cache || new PeerCache()
    const cloud = opts.cloud || new CloudCache(opts)

    // Deliberately does NOT wait for shared nodes any more.
    //
    // That wait existed to get known-good nodes into the bootstrap array,
    // because bootstrap gated `ready` and `ready` gated the decision —
    // worth ~800ms against a 5.1s bootstrap. Now that _probePeers never
    // waits for `ready`, the decision is ~924ms end to end, and blocking
    // it on a 400-800ms network round trip to shave DHT bootstrap is a
    // straight loss: it nearly doubled the cost when the control plane
    // was unreachable. Shared nodes are folded in asynchronously instead
    // (see the constructor); they still improve DHT peer yield, they just
    // no longer sit on the critical path.
    return new SwarmScout({ ...opts, cache, cloud })
  }

  constructor (opts = {}) {
    this.probeBudgetMs = opts.probeBudgetMs || DEFAULT_BUDGET_MS
    this.cache = opts.cache || new PeerCache()
    this.cloud = opts.cloud || new CloudCache(opts)
    this.dhtReady = null

    // Re-seed from disk and from shared state, but *behind* the public
    // bootstrap domains.
    //
    // The obvious order is the opposite, and this code used to do it: ping
    // known-good nodes first and treat the hardcoded domains as a last
    // resort, the way nodes.dat / dhtnodes.dat clients do. Measured in
    // production, that is a trap. `k-rpc` caps in-flight queries at 16 for
    // the entire socket, so 50 cached entries ahead of the public ones means
    // the public ones are not in the first wave at all — and if the cached
    // table has gone stale, every one of those 50 costs a timeout before
    // anything alive is reached. Observed directly on the hosted engine: a
    // stale 93-node table produced 0-1 peers per lookup, and clearing it took
    // the same query to 946. Nothing reported an error; the swarms simply
    // looked dead, which is the failure signature this project keeps hitting.
    //
    // Two live domains cost two slots out of sixteen and are re-verified by
    // `npm run check-bootstrap`. Cached and shared nodes still go in the
    // bootstrap array rather than a later addNode(), because bittorrent-dht
    // gates its `ready` event on the populate() pass — they just no longer
    // get to starve the one entry that is known to answer.
    const cachedNodes = this.cache.getNodes()
    const shared = (opts.sharedNodes || []).slice(0, MAX_SHARED_BOOTSTRAP)
    const bootstrap = [
      ...(opts.dhtBootstrap || DEFAULT_DHT_BOOTSTRAP),
      ...cachedNodes.slice(0, MAX_CACHED_BOOTSTRAP).map(n => `${n.host}:${n.port}`),
      ...shared.map(n => `${n.host}:${n.port}`)
    ]
    if (cachedNodes.length || shared.length) {
      console.log(`[scout] bootstrapping from ${Math.min(cachedNodes.length, MAX_CACHED_BOOTSTRAP)} cached + ${shared.length} shared + ${(opts.dhtBootstrap || DEFAULT_DHT_BOOTSTRAP).length} public nodes`)
    }

    // One shared DHT instance for all lookups — cheaper than spinning
    // up a new UDP socket + routing table per candidate.
    //
    // `concurrency` is the important argument. k-rpc defaults it to 16 —
    // in-flight queries across the *whole* socket — and anything beyond that
    // sits in a pending list until a slot frees. That ceiling is invisible
    // to callers: a query that is still queued looks identical to one that
    // was sent and ignored, so a caller's own timeout fires on a request the
    // socket never transmitted.
    //
    // It is generous for ranking a handful of candidates and nowhere near
    // enough for the crawler, which runs 160 workers over this one socket.
    // Left at the default, the crawl stalled within ninety seconds every
    // time, and stalled *sooner* the more workers were added — the signature
    // of queueing rather than of network limits.
    this.dht = new DHT({ bootstrap, concurrency: opts.dhtConcurrency || DHT_CONCURRENCY })
    this.dht.listen(0)

    // Non-fatal by design: a malformed KRPC reply from one hostile or
    // buggy node should not take the process down. These fire routinely
    // on the real DHT (observed: "Invalid data: Missing delimiter",
    // "not a number: buffer[0] = 193").
    this.dht.on('error', err => console.warn('[scout] dht error:', err.message))
    this.dht.on('warning', () => {})

    // Warm client: never block on the network for something disk already
    // provided. Fold shared nodes in asynchronously — this enriches the
    // routing table but, as established, does not change time-to-ready,
    // so there is nothing to gain by waiting.
    if (this.cloud.enabled) {
      this.cloud.getNodes().then(nodes => {
        if (!nodes?.length || this.dht.destroyed) return
        let added = 0
        for (const n of nodes) {
          try { this.dht.addNode(n); added++ } catch { /* one bad node is not fatal */ }
        }
        console.log(`[scout] folded in ${added} shared DHT nodes`)
      }).catch(() => {})
    }

    // How live peers are discovered. The DHT is right for the open
    // internet; inside a fleet the membership is already known, and asking
    // a public DHT about hosts you could simply connect to is both slower
    // and a worse liveness signal. See peerSources.js.
    this.peerSource = opts.peerSource || createPeerSource({
      dht: this.dht,
      members: opts.members,
      mode: opts.mode
    })

    this._dhtReady = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`DHT failed to bootstrap within ${DHT_BOOTSTRAP_TIMEOUT_MS}ms`)),
        DHT_BOOTSTRAP_TIMEOUT_MS
      )
      this.dht.once('ready', () => { clearTimeout(timer); resolve() })
    })
    // Avoid an unhandled rejection if nobody awaits ready() before rank().
    this._dhtReady.catch(() => {})
  }

  /**
   * Wait for the DHT to bootstrap.
   *
   * Deliberately NOT inside the per-candidate probe budget. Bootstrap
   * measured 2.5-5s cold against live nodes, which already exceeds
   * probeBudgetMs (4s) on its own — folding it into the budget made
   * every candidate time out and score 0 on the very first run, and
   * StreamServer then threw "No candidate had a usable score". Pay the
   * bootstrap cost once, up front, then give each candidate its full
   * budget.
   */
  async ready () {
    try {
      await this._dhtReady
      return true
    } catch (err) {
      // Trackers alone are still a usable discovery path.
      console.warn(`[scout] ${err.message} — continuing with trackers only`)
      return false
    }
  }

  /**
   * @param {Array<{infoHash: string, trackers: string[], magnetURI: string, label?: string}>} candidates
   * @returns {Promise<Array<{infoHash:string, magnetURI:string, score:number, peers:Array, sources:object}>>}
   *          Ranked best-first. Empty peers/low score entries are still
   *          included so the caller can decide its own cutoff.
   */
  async rank (candidates, { sharedFirst = true } = {}) {
    const hashes = candidates.map(c => c.infoHash)

    // Start the shared lookup before waiting on the DHT: if it covers
    // everything, we never need to pay for bootstrap before deciding.
    const sharedPromise = this.cloud.enabled
      ? this.cloud.getHealth(hashes)
      : Promise.resolve(null)

    if (sharedFirst && this.cloud.enabled) {
      const shared = await sharedPromise
      if (shared && this._coversAll(shared, hashes)) {
        const ranked = this._rankFromShared(candidates, shared)
        // Decide now, verify later: playback can start while a full local
        // probe runs in the background and refreshes both caches for the
        // next caller. This — not the ~120-800ms scrape saving — is what
        // the shared health cache is actually for.
        this._backgroundRefresh(candidates)
        return ranked
      }
    }

    // No `await this.ready()` here.
    //
    // The DHT is usable long before its `ready` event fires (see
    // _probePeers), so blocking the decision on bootstrap cost ~5s per cold
    // start for nothing. Bootstrap continues in the background; the
    // lookups fired below work against whatever the routing table already
    // holds, which measured 84 peers within 1.5s of process start.
    const shared = await sharedPromise

    const results = await Promise.allSettled(
      candidates.map(c => this._withTimeout(this._scoreCandidate(c, shared?.[c.infoHash.toLowerCase()]), this.probeBudgetMs, c))
    )

    const scored = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      // Timed out or errored: still return a zero-score placeholder so
      // the shape is uniform and the candidate can be retried later.
      return {
        infoHash: candidates[i].infoHash,
        magnetURI: candidates[i].magnetURI,
        label: candidates[i].label,
        trackers: candidates[i].trackers,
        score: 0,
        peers: [],
        sources: { error: r.reason?.message }
      }
    })

    this._persistNodes()
    this._reportHealth(scored)

    scored.sort((a, b) => b.score - a.score)
    return scored
  }

  /** True when shared health has a fresh entry for every candidate. */
  /**
   * True only when shared health can answer for *every* candidate, freshly.
   *
   * Both conditions matter. Partial coverage is useless because ranking
   * compares candidates against each other — mixing a shared reading for one
   * against a fresh probe of another compares two different instruments, and
   * the gap between them is larger than the differences being ranked on.
   *
   * Freshness is checked twice over: the server's own `confidence` tier is
   * honoured when present, and the age is re-checked locally regardless. The
   * local check is not redundant — the server's clock, the edge cache and
   * the wire all add age after the tier was computed, and a client that
   * trusts a stale reading promotes a dead candidate and pays a stall cycle
   * to find out. When in doubt, probing locally costs ~900ms; being wrong
   * costs a playback stall.
   */
  _coversAll (shared, hashes) {
    const now = Date.now()
    return hashes.every(h => {
      const e = shared[h.toLowerCase()]
      if (!e) return false
      if (e.confidence === 'stale') return false
      return now - e.ts < SHARED_HEALTH_MAX_AGE_MS
    })
  }

  /**
   * Build a ranking purely from shared health, using the same weights as
   * a local probe so the two are directly comparable — the benchmark's
   * rank-inversion metric depends on that.
   */
  _rankFromShared (candidates, shared) {
    const scored = candidates.map(c => {
      const e = shared[c.infoHash.toLowerCase()]
      const cached = this.cache.get(c.infoHash)
      return {
        infoHash: c.infoHash,
        magnetURI: c.magnetURI,
        label: c.label,
        trackers: c.trackers,
        score: e.seeders * 10 + e.dhtPeerCount * 4 + e.leechers * 1,
        // Peers still come from this machine's own cache, never from the
        // control plane — it deliberately stores no peer lists.
        peers: cached?.peers || [],
        source: 'shared',
        sources: {
          seeders: e.seeders,
          leechers: e.leechers,
          dhtCount: e.dhtPeerCount,
          fromShared: true,
          ageMs: Date.now() - e.ts
        }
      }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored
  }

  /** Probe in the background after answering from shared health. */
  _backgroundRefresh (candidates) {
    if (this._refreshing) return
    this._refreshing = true
    this.ready()
      .then(ok => {
        this.dhtReady = ok
        return Promise.allSettled(candidates.map(c => this._scoreCandidate(c)))
      })
      .then(results => {
        const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value)
        this._persistNodes()
        this._reportHealth(ok)
      })
      .catch(() => {})
      .finally(() => { this._refreshing = false })
  }

  /** Publish what we measured so the next client can skip the probe. */
  _reportHealth (scored) {
    if (!this.cloud.enabled) return
    const reports = scored
      .filter(r => r.source !== 'shared' && r.sources && !r.sources.error)
      .map(r => ({
        infoHash: r.infoHash,
        seeders: r.sources.seeders || 0,
        leechers: r.sources.leechers || 0,
        dhtPeerCount: r.sources.dhtCount || 0
      }))
    if (reports.length) this.cloud.reportHealth(reports)
  }

  async _scoreCandidate (candidate, sharedEntry) {
    const cached = this.cache.get(candidate.infoHash)

    const [scrape, dhtPeers] = await Promise.all([
      this._scrapeTrackers(candidate).catch(() => null),
      this._probePeers(candidate.infoHash).catch(() => [])
    ])

    // Weighted health score. Tune these weights against real traffic;
    // the intent is: real seeders >> DHT peer hits >> leechers.
    let seeders = scrape?.complete ?? 0
    let leechers = scrape?.incomplete ?? 0
    const dhtCount = dhtPeers.length

    // If no tracker answered at all, a 0 here means "we learned nothing",
    // not "the swarm is empty" — the same asymmetry the Worker guards
    // against on write. Fall back to a recent shared observation rather
    // than scoring a healthy swarm at zero.
    let filledFromShared = false
    if ((!scrape || scrape.responded === 0) && sharedEntry &&
        Date.now() - sharedEntry.ts < SHARED_HEALTH_MAX_AGE_MS) {
      seeders = sharedEntry.seeders
      leechers = sharedEntry.leechers
      filledFromShared = true
    }

    // Weight peers by where they are, not just how many there are.
    //
    // The flat `dhtCount * 4` assumed every peer is equally far away. That
    // holds on the public internet and is badly wrong in a fleet, where it
    // ranks 20 seeders in another region above 4 in the same rack — the
    // opposite of what you want, since rack-local transfer is cheaper in
    // both latency and cross-AZ egress.
    //
    // Each peer now contributes its own locality factor, so 4 rack-local
    // peers (~3.0 each) outweigh 20 distant ones (~0.4 each).
    const peerWeight = weightedPeerCount(dhtPeers)

    // Scrape counts are swarm-wide and carry no addresses, so they cannot be
    // weighted per peer. The peers we did observe are the only evidence of
    // how far this swarm sits, so their mean locality scales that half.
    // With no observations this is exactly 1.0 and the score is untouched,
    // which keeps public-internet behaviour identical to before.
    const locality = meanLocality(dhtPeers)

    let score = (seeders * 10 + leechers * 1) * locality + peerWeight * 4

    // A candidate we already know was healthy recently gets a small
    // boost — breaks ties in favor of "known good," and lets the
    // caller start connecting to cached peers immediately while this
    // fresh probe confirms/updates the number in the background.
    if (cached) score += Math.min(cached.score, 20)

    score = Math.round(score)

    const peers = dedupePeers([
      ...(cached?.peers || []),
      ...dhtPeers
    ])

    this.cache.set(candidate.infoHash, { peers, score })

    return {
      infoHash: candidate.infoHash,
      magnetURI: candidate.magnetURI,
      label: candidate.label,
      trackers: candidate.trackers,
      score,
      peers,
      source: 'probed',
      sources: {
        seeders,
        leechers,
        dhtCount,
        // Surfaced so a ranking that disagrees with the raw counts is
        // explainable rather than mysterious.
        peerWeight: Number(peerWeight.toFixed(2)),
        locality: Number(locality.toFixed(2)),
        via: this.peerSource.name,
        fromCache: !!cached,
        filledFromShared
      }
    }
  }

  _scrapeTrackers (candidate) {
    if (!candidate.trackers || candidate.trackers.length === 0) return Promise.resolve(null)

    // bittorrent-tracker's scrape() silently returns complete/incomplete/
    // downloaded = 0 — with NO error — when infoHash is a hex string. It
    // has to be a 20-byte Buffer. Verified against a raw BEP-15 UDP
    // scrape of the same tracker in the same second:
    //   hex string -> 0 / 0 / 0
    //   Buffer     -> 121 seeders / 1420 downloaded / 35 leechers
    // Since seeders carries the heaviest weight in the score, passing a
    // string quietly reduced ranking to DHT-only.
    const infoHash = Buffer.from(candidate.infoHash, 'hex')

    return Promise.resolve().then(() => new Promise(resolve => {
      const best = { complete: 0, incomplete: 0, responded: 0 }
      let pending = candidate.trackers.length
      let settled = false
      let graceTimer = null

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        resolve(best)
      }
      const countDown = () => { if (--pending === 0) finish() }

      // Don't wait for every tracker once one has answered.
      //
      // Measured: the first tracker answers in 133-147ms while the rest
      // trail at 437-697ms and dead ones burn the full per-tracker
      // ceiling. Waiting for all of them turned a ~140ms signal into a
      // 2500ms one. After the first success, allow a short grace window
      // for another tracker to report a higher count, then decide.
      const onFirstSuccess = () => {
        if (!graceTimer && !settled) graceTimer = setTimeout(finish, SCRAPE_GRACE_MS)
      }

      candidate.trackers.forEach(announce => {
        let done = false
        // Per-tracker ceiling. Without it, one hung tracker keeps
        // `pending` above zero indefinitely and the whole probe rides on
        // the outer timeout instead of returning the results that did
        // land. Measured: tracker.openbittorrent.com:6969 never answers
        // and burned the full 8s window in testing.
        const timer = setTimeout(() => {
          if (!done) { done = true; countDown() }
        }, SCRAPE_TIMEOUT_MS)

        try {
          TrackerClient.scrape({ infoHash, announce }, (err, data) => {
            if (done) return
            done = true
            clearTimeout(timer)
            if (!err && data) {
              best.complete = Math.max(best.complete, data.complete || 0)
              best.incomplete = Math.max(best.incomplete, data.incomplete || 0)
              best.responded++
              onFirstSuccess()
            }
            countDown()
          })
        } catch {
          if (!done) { done = true; clearTimeout(timer); countDown() }
        }
      })
    }))
  }

  /**
   * Collect DHT peers for one infohash.
   *
   * Deliberately does NOT await the DHT's `ready` event.
   *
   * `ready` fires only after bittorrent-dht completes a full `find_node`
   * populate pass, measured at 5571ms cold - but the routing table has
   * usable nodes almost immediately (first node known at 84ms), and
   * `lookup()` works fine against a partly-populated table. Measured
   * side by side on the same infohash:
   *
   *   await ready, then look up : first peer at 5810ms
   *   look up immediately       : first peer at  844ms, 84 peers by 1.5s
   *
   * Waiting on `ready` was costing ~5s of pure latency on every cold
   * start and buying no extra information.
   */
  /**
   * Collect live peers for an infohash inside a bounded window.
   *
   * The transport behind this is pluggable — the public DHT, or a direct
   * connect-and-handshake sample against a known roster on a private
   * network. See peerSources.js. Everything downstream (scoring, caching,
   * peer injection, failover) is written against this shape alone and does
   * not know or care which one answered.
   */
  async _probePeers (infoHash, windowMs = DHT_WINDOW_MS) {
    try {
      return await this.peerSource.sample(infoHash, windowMs)
    } catch {
      // Discovery is one signal among several; a failure here must not fail
      // the candidate, which may still have healthy tracker counts.
      return []
    }
  }

  /**
   * Flush the routing table so the next cold start can skip bootstrap,
   * and contribute it to the shared pool so *other* cold clients can too.
   * The contribution lands in its own key server-side, so this never
   * contends with other clients' writes.
   */
  _persistNodes () {
    try {
      const nodes = this.dht.toJSON().nodes
      if (nodes?.length) {
        this.cache.setNodes(nodes)
        this.cloud.reportNodes(nodes.slice(0, 100))
      }
    } catch (err) {
      console.warn('[scout] failed to persist DHT nodes:', err.message)
    }
  }

  _withTimeout (promise, ms, candidate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms for ${candidate.label || candidate.infoHash}`)), ms)
      promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
    })
  }

  /**
   * Rank, then actually verify — one call.
   *
   * `rank()` answers "how healthy do the signals say this is". It cannot
   * answer "is this real", and the difference is not academic: a tracker
   * scrape returns counts with no addresses and nothing checks them, so an
   * infohash that has never existed scored 958 here on 45 claimed seeders
   * and 465 leechers, out-ranking a torrent that streams. Hundreds of
   * clients announcing to a placeholder hash produce a swarm that is real
   * in the tracker's ledger and empty everywhere else.
   *
   * So this asks a peer to prove it. `ut_metadata` verifies SHA1(info)
   * against the infohash before returning, which makes a successful fetch
   * the only signal here that cannot be faked or mistaken.
   *
   * Four outcomes, because two would lose the distinction that matters:
   *
   *   verified   a peer served the real torrent
   *   reachable  peer addresses found, none served metadata
   *   claimed    trackers report a swarm, no address was obtained
   *   none       no signal anywhere
   *
   * `claimed` is emphatically not `none`. Absence of proof is not proof of
   * absence: some healthy swarms have no reachable DHT presence at all
   * (measured — Ubuntu's returned zero peers at every window up to 15s
   * while Sintel saturated at 202 by 900ms), and scrape yields no addresses
   * to verify with. Collapsing `claimed` into dead hides working torrents.
   *
   * @param {Array} candidates - as rank(); parseInput() in catalog.js builds them
   * @param {object} [opts]
   * @param {boolean} [opts.verify=true] - false makes this rank() plus a verdict
   * @param {number} [opts.maxPeers=40] - peers to try per candidate
   * @param {number} [opts.deadlineMs=20000] - overall verification budget; 0 disables
   * @param {number} [opts.concurrency=6] - peers tried at once per candidate
   * @param {PeerTable} [opts.table] - reuse across calls to skip known-dead addresses
   * @returns {Promise<Array>} ranked entries, each with verdict/verified/meta
   */
  async assess (candidates, {
    verify = true, maxPeers = 40, deadlineMs = 20_000, concurrency = 6, table = null
  } = {}) {
    // Shared health can answer a *ranking* without touching the DHT, and for
    // rank() that is the whole point. For verification it is worse than
    // useless: the control plane deliberately never stores peer lists (a
    // routing node is infrastructure, a peer address is a record of who was
    // transferring what), so an answer from shared health arrives with
    // `peers: []` and there is nothing to ask for the torrent. Left alone,
    // every candidate the control plane covers came back `claimed` — the
    // verdict that means "trackers say yes, nothing was proven" — and the
    // failure looked exactly like a legitimately unprovable swarm.
    //
    // So verification forces a real probe. Ranking keeps its shortcut.
    const ranked = await this.rank(candidates, { sharedFirst: !verify })
    // Shared across candidates on purpose: address liveness is a property of
    // the address, not of the hash it was found under, so what one candidate
    // learns about a dead peer saves the next one a connection.
    const shared = table || new PeerTable()

    const assessed = await Promise.all(ranked.map(async r => {
      const peers = r.peers || []
      let meta = null
      let verifyMs = null

      // Peers first, in parallel across candidates. Within one candidate
      // fetchFromAny stays sequential — peers for a single hash are highly
      // correlated, so racing them mostly multiplies connections to a dead
      // swarm.
      let timedOut = false
      if (verify && peers.length) {
        const t0 = Date.now()
        // Bounded, because the peer loop is sequential and each dead address
        // costs its connect deadline — 40 peers is a worst case of ~48s,
        // which is fine for a sweep and far too slow behind an HTTP request.
        // Whatever has not answered by the deadline is reported as
        // unverified rather than held onto; the peers keep their own
        // per-connection timeouts and wind down on their own.
        const attempt = fetchFromAny(r.infoHash, peers, { maxPeers, table: shared, concurrency })
        meta = deadlineMs > 0
          ? await Promise.race([
            attempt,
            new Promise(resolve => setTimeout(() => { timedOut = true; resolve(null) }, deadlineMs))
          ])
          : await attempt
        verifyMs = Date.now() - t0
      }

      const claimed = (r.sources?.seeders || 0) + (r.sources?.leechers || 0) > 0
      const verdict = meta?.ok
        ? 'verified'
        : peers.length
          ? 'reachable'
          : claimed ? 'claimed' : 'none'

      return {
        ...r,
        verdict,
        verified: verdict === 'verified',
        // A `reachable` that ran out of budget is a different claim from one
        // where every peer was asked and refused. Callers re-probing on a
        // schedule should not count the first as evidence of anything.
        verifyTimedOut: timedOut,
        verifyMs,
        meta: meta?.ok
          ? { name: meta.name, size: meta.size, files: meta.files, paths: meta.paths }
          : null
      }
    }))

    // Proof outranks claims, and score only breaks ties inside a tier.
    //
    // Sorting on score alone is what let a nonexistent hash place above a
    // torrent that streams. Sorting on proof alone would be the opposite
    // error — it would bury a healthy tracker-only swarm under anything the
    // DHT happened to answer for. Tiers keep both from happening: nothing
    // unproven can outrank something proven, and nothing loses its score.
    const rankOf = { verified: 0, reachable: 1, claimed: 2, none: 3 }
    assessed.sort((a, b) => rankOf[a.verdict] - rankOf[b.verdict] || b.score - a.score)
    return assessed
  }

  destroy () {
    this._persistNodes()
    this.peerSource?.destroy?.()
    this.dht.destroy()
    this.cache?.close?.()
  }
}

function dedupePeers (peers) {
  const seen = new Set()
  const out = []
  for (const p of peers) {
    const key = `${p.host}:${p.port}`
    if (!seen.has(key)) { seen.add(key); out.push(p) }
  }
  return out
}
