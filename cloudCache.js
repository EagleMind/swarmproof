'use strict'

/**
 * CloudCache
 * ----------
 * Client for the swarmproof control plane (see worker/src/index.js).
 *
 * The single rule this file exists to enforce: **the control plane is an
 * accelerator, never a dependency.** Every method is capped by a short
 * deadline and resolves to `null` on any failure — unreachable host, DNS
 * failure, timeout, non-200, malformed JSON. Nothing here ever throws at
 * the caller, and nothing here is ever awaited on a path that must
 * complete. If the Worker is down, discovery must behave exactly as it
 * did before this file existed, at the same speed.
 *
 * Disabled entirely when no endpoint is configured, so the default
 * offline path stays zero-cost.
 */

// Both budgets were sized when a cold local probe took ~7.6s, so 500-800ms
// looked negligible. It no longer is: the local probe is now ~924ms, so an
// 800ms node fetch nearly doubled the failure path. These must stay small
// relative to simply doing the work locally.
const DEFAULT_READ_TIMEOUT_MS = 300 // health: must not delay ranking
const DEFAULT_NODES_TIMEOUT_MS = 400 // nodes: never blocked on, see SwarmScout.create
const DEFAULT_WRITE_TIMEOUT_MS = 2000 // fire-and-forget; nobody waits on these
const DEFAULT_BREAKER_MS = 10_000 // after a failure, stop calling for this long

export default class CloudCache {
  /**
   * @param {object} opts
   * @param {string} [opts.endpoint] - base URL, e.g. https://swarmproof-control.workers.dev
   * @param {number} [opts.readTimeoutMs]
   * @param {number} [opts.nodesTimeoutMs]
   */
  constructor (opts = {}) {
    const endpoint = opts.endpoint || process.env.SWARMPROOF_API || ''
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.enabled = !!this.endpoint
    this.readTimeoutMs = opts.readTimeoutMs || DEFAULT_READ_TIMEOUT_MS
    this.nodesTimeoutMs = opts.nodesTimeoutMs || DEFAULT_NODES_TIMEOUT_MS
    this.writeTimeoutMs = opts.writeTimeoutMs || DEFAULT_WRITE_TIMEOUT_MS
    this.breakerMs = opts.breakerMs ?? DEFAULT_BREAKER_MS
    this._openUntil = 0
    // waitMs accumulates only calls the caller BLOCKS on (the two reads),
    // never fire-and-forget writes. This is the honest cost of the control
    // plane on the critical path, measured directly instead of inferred by
    // differencing two scenarios whose DHT bootstrap variance (2.5-5.6s)
    // is an order of magnitude larger than the thing being measured.
    this.stats = { hits: 0, misses: 0, errors: 0, shortCircuited: 0, waitMs: 0, calls: 0 }
  }

  async _fetch (path, { method = 'GET', body, timeoutMs, blocking = false } = {}) {
    if (!this.enabled) return null
    const t0 = blocking ? Date.now() : 0
    const charge = () => { if (blocking) { this.stats.waitMs += Date.now() - t0; this.stats.calls++ } }

    // Circuit breaker, on the blocking reads only. Without it, an
    // unreachable control plane costs the full timeout on *every* call —
    // measured as +1274ms over baseline on a cold start, because the node
    // fetch and the health fetch each hung for their own deadline in
    // sequence. One failure is enough evidence for the rest of a short run:
    // this is an accelerator, so when it stops accelerating it should get
    // out of the way immediately.
    //
    // `blocking` is what makes that argument hold, and it is not decoration.
    // The cost the breaker exists to avoid is latency on the decision path,
    // and only the two reads sit there. Applied to writes as well, it did
    // something quite different and entirely unintended: a health read that
    // overran its 300ms budget by 6ms tripped the breaker, and both
    // fire-and-forget writes that follow ~1s later — well inside the 10s
    // window — were short-circuited in 0ms and never sent. Every run
    // consumed shared state and contributed nothing back, which is why the
    // deployed pool sat at 0 nodes while reporting contributions. Nothing
    // waits on a write, so a slow read is no reason to suppress one; a
    // write that is genuinely going nowhere is already capped by its own
    // 2s deadline. Failures from either still trip the breaker — a dead
    // control plane should stop costing the decision path immediately.
    if (blocking && Date.now() < this._openUntil) {
      this.stats.shortCircuited++
      charge()
      return null
    }

    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) { this._trip(); charge(); return null }
      this._openUntil = 0
      const out = await res.json()
      charge()
      return out
    } catch {
      // Timeout, DNS failure, connection refused, bad JSON — all the same
      // to the caller: no data, carry on locally.
      this._trip()
      charge()
      return null
    }
  }

  _trip () {
    this.stats.errors++
    this._openUntil = Date.now() + this.breakerMs
  }

  /**
   * @param {string[]} infoHashes
   * @returns {Promise<object|null>} { [infoHash]: {seeders, leechers, dhtPeerCount, reports, ts} }
   */
  async getHealth (infoHashes) {
    if (!this.enabled || !infoHashes?.length) return null
    const qs = infoHashes.map(h => `ih=${encodeURIComponent(h.toLowerCase())}`).join('&')
    const data = await this._fetch(`/v1/health?${qs}`, { timeoutMs: this.readTimeoutMs, blocking: true })
    if (!data?.health) return null

    const found = Object.keys(data.health).length
    if (found) this.stats.hits += found
    this.stats.misses += infoHashes.length - found
    return data.health
  }

  /** Fire-and-forget. Returns a promise only so callers can await it in tests. */
  reportHealth (reports) {
    if (!this.enabled || !reports?.length) return Promise.resolve(null)
    return this._fetch('/v1/health', {
      method: 'POST',
      body: { reports },
      timeoutMs: this.writeTimeoutMs
    })
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.blocking] - count this call toward stats.waitMs.
   *   Defaults to false: since SwarmScout.create stopped awaiting shared
   *   nodes, nothing on the decision path blocks on this, and charging it
   *   to waitMs overstated the failure cost (712ms reported against a
   *   true D-A of +304ms).
   * @returns {Promise<Array<{host:string, port:number}>|null>}
   */
  async getNodes ({ blocking = false } = {}) {
    if (!this.enabled) return null
    const data = await this._fetch('/v1/dht/nodes', { timeoutMs: this.nodesTimeoutMs, blocking })
    if (!Array.isArray(data?.nodes)) return null
    return data.nodes
  }

  /** Fire-and-forget. */
  reportNodes (nodes) {
    if (!this.enabled || !nodes?.length) return Promise.resolve(null)
    return this._fetch('/v1/dht/nodes', {
      method: 'POST',
      body: { nodes: nodes.map(n => ({ host: n.host, port: n.port })) },
      timeoutMs: this.writeTimeoutMs
    })
  }
}
