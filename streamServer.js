'use strict'

import http from 'http'
import mime from 'mime-types'
import WebTorrent from 'webtorrent'

const STALL_CHECK_MS = 5000
const STALL_MIN_PEERS = 1
const STALL_MIN_BYTES_PER_CHECK = 32 * 1024 // 32KB/5s ~ dead swarm
const STALL_GRACE_MS = 15000 // don't judge a swarm before it has announced/handshaked
const STALL_STRIKES = 3      // consecutive bad checks before failing over

/**
 * Cap on peers injected from discovery.
 *
 * More is NOT better, and the original "inject everything we found" was a
 * pessimisation. WebTorrent has a finite connection pool, and most DHT
 * peers for a given infohash are unreachable, so flooding it with
 * hundreds of them fills the pool with failing handshakes and starves the
 * reachable tracker-supplied peers. Measured over 3 runs each on the same
 * torrent:
 *
 *   inject 10  -> first byte 1752ms (median), 10/9/7 peers connected
 *   inject 495 -> first byte 2528ms (median),  4/4/4 peers connected
 *
 * Metadata time was the same either way (~800ms); the damage is to piece
 * throughput afterwards. A handful of warm peers beats a flood of cold ones.
 */
const MAX_INJECTED_PEERS = 12

/**
 * How long a candidate gets to produce metadata before it is written off.
 *
 * Measured cold start on a healthy swarm is ~800-1800ms, so this is very
 * generous — it exists to catch the pathological case (a swarm with no
 * reachable peers at all), not to police slow ones.
 */
const METADATA_TIMEOUT_MS = 25000

/**
 * How many candidates race at once.
 *
 * They share a single WebTorrent connection pool, so this is a real
 * tradeoff rather than a free win: a few racers explore genuinely different
 * swarms, while a dozen mostly starve each other.
 */
const MAX_RACERS = 4

/**
 * StreamServer
 * ------------
 * Owns a single active WebTorrent client + torrent at a time, plus an
 * HTTP server that serves the largest media file with Range support
 * (required for seeking and for most players/`<video>` tags).
 *
 * Failover: if the active swarm goes quiet (no peers, or no bytes
 * flowing) for too long, it tears down and promotes the next
 * candidate from the ranked list SwarmScout produced — no re-running
 * discovery from scratch, since that list is already sorted by
 * health.
 */
export default class StreamServer {
  constructor ({ port = 0 } = {}) {
    this.port = port
    this.client = new WebTorrent()

    // A client-level error must not take the process down.
    //
    // WebTorrent emits 'error' for things that are not fatal to streaming —
    // most notably a uTP socket that cannot bind. Observed on Windows as
    // `EACCES` from utp-native when a previous run still held the port; with
    // no listener attached, Node turned that into an unhandled 'error' event
    // and killed the whole engine. uTP is one of two transports, and the
    // TCP peer wire is unaffected, so this is worth a warning and nothing more.
    this.client.on('error', err => {
      console.warn('[stream] webtorrent:', err?.message || err)
    })
    this.httpServer = http.createServer((req, res) => this._handleRequest(req, res))
    this.torrent = null
    this.file = null
    this.rankedCandidates = []
    this.candidateIndex = -1
    this._stallTimer = null
    this._lastDownloaded = 0
    this._switching = false
    this._strikes = 0
    this._aborted = false
    this._excluded = new Set()
  }

  listen () {
    return new Promise(resolve => {
      this.httpServer.listen(this.port, () => resolve(this.httpServer.address().port))
    })
  }

  /**
   * @param {Array} rankedCandidates - output of SwarmScout#rank(), best first
   */
  async play (rankedCandidates) {
    this.rankedCandidates = rankedCandidates.filter(c => c.score > 0)

    // A zero score means discovery learned nothing, NOT that the swarm is
    // dead — a scrape that failed and a DHT window that closed early both
    // produce 0. Refusing to play in that case is the wrong call: the
    // torrent may well be healthy, and WebTorrent runs its own discovery
    // anyway. Try them in the caller's order rather than giving up.
    if (this.rankedCandidates.length === 0) {
      if (!rankedCandidates.length) {
        throw new Error('No candidates supplied — nothing to stream from')
      }
      console.warn('[stream] every candidate scored 0 — discovery learned nothing; trying them in order anyway')
      this.rankedCandidates = rankedCandidates.slice()
    }
    this.candidateIndex = -1
    // A previous abort() must not poison this run.
    this._aborted = false
    this._excluded = new Set()

    // Two candidates can legitimately carry the same infohash (the same
    // release listed twice). WebTorrent throws on a duplicate add, which
    // would fail the whole race, so collapse them here.
    const seen = new Set()
    this.rankedCandidates = this.rankedCandidates.filter(c => {
      if (seen.has(c.infoHash)) return false
      seen.add(c.infoHash)
      return true
    })

    await this._advanceToNextCandidate()
  }

  async _advanceToNextCandidate () {
    // Failover is async (destroy + re-add + wait for metadata), and the
    // stall watchdog keeps ticking throughout. Without this guard a
    // single stall fires a failover every STALL_CHECK_MS and burns the
    // whole candidate list in a few seconds.
    if (this._switching) return
    this._switching = true
    try {
      await this._doAdvance()
    } finally {
      this._switching = false
    }
  }

  /**
   * Start every remaining candidate at once and keep whichever is first to
   * actually become playable.
   *
   * This replaces trying candidates one at a time in ranked order. Ranking
   * predicts which swarm should be fastest from seeder counts and DHT hits;
   * racing measures which one *is*. The two usually agree, and when they
   * disagree the measurement is right — a swarm can advertise 260 seeders
   * and still hand you nothing, and the sequential version paid a full
   * metadata timeout to discover that before it would even look at the
   * runner-up.
   *
   * The ranked order is still used, as the tiebreak when several candidates
   * become playable in the same instant and to decide who gets injected
   * peers first, so the probing work is not wasted.
   *
   * Cost: N torrents briefly share one connection pool. That is why
   * MAX_RACERS exists — past a handful, the racers starve each other and
   * everyone gets slower.
   */
  async _doAdvance () {
    clearInterval(this._stallTimer)
    this._stallTimer = null

    if (this._aborted) throw new Error('superseded')

    const remaining = this.rankedCandidates.filter(c => !this._excluded.has(c.infoHash))
    if (!remaining.length) throw new Error('Exhausted all ranked candidates — none stayed healthy')

    await this._teardownTorrent()

    const racers = remaining.slice(0, MAX_RACERS)
    console.log(`[stream] racing ${racers.length} candidate(s): ${racers.map(c => c.label || c.infoHash).join(', ')}`)

    const started = []
    const attempts = racers.map(async candidate => {
      // Prefer the actual .torrent when the caller resolved one. A magnet
      // forces WebTorrent to fetch metadata from a peer over ut_metadata,
      // which never completes for a torrent whose only source is an HTTP
      // web seed.
      const torrent = this.client.add(candidate.torrentFile || candidate.magnetURI, {
        // Seed the swarm with peers SwarmScout already found so we skip
        // the cold-start handshake dance.
        announce: candidate.trackers || []
      })
      started.push(torrent)

      // Manually inject already-known peers (from DHT probe / cache) so the
      // first connections happen immediately instead of waiting for
      // WebTorrent's own discovery to warm up.
      //
      // client.add() parses the magnet URI asynchronously, so the torrent
      // has no infoHash on the tick it is returned and addPeer() throws
      // "must not be called before the `infoHash` event".
      this._injectPeers(torrent, candidate.peers || [])

      await this._waitForMetadata(torrent)

      const file = this._pickMediaFile(torrent)
      if (!file) throw new Error(`${candidate.label || candidate.infoHash}: no playable media file`)

      return { torrent, file, candidate }
    })

    let winner
    try {
      // Promise.any settles on the first *success*, which is exactly the
      // semantics wanted here: losers and outright failures are equivalent.
      winner = await Promise.any(attempts)
    } catch (aggregate) {
      started.forEach(t => t.destroy(() => {}))
      racers.forEach(c => this._excluded.add(c.infoHash))
      if (this._aborted) throw new Error('superseded')
      const why = (aggregate.errors || []).map(e => e.message).join('; ')
      throw new Error(`No candidate became playable (${why || 'unknown'})`)
    }

    if (this._aborted) {
      started.forEach(t => t.destroy(() => {}))
      throw new Error('superseded')
    }

    // Losing racers are torn down immediately — leaving them running would
    // keep competing for the same connection pool the winner now needs.
    for (const t of started) {
      if (t !== winner.torrent) t.destroy(() => {})
    }

    this.torrent = winner.torrent
    this.file = winner.file
    this.candidateIndex = this.rankedCandidates.indexOf(winner.candidate)
    // Only the winner is retired. A candidate that merely lost the race may
    // still be perfectly healthy, so it stays eligible for the next one.
    this._excluded.add(winner.candidate.infoHash)

    console.log(`[stream] winner: ${winner.candidate.label || winner.candidate.infoHash} (${winner.file.name})`)

    this._prioritizeStart(this.file)
    this._resetStallWatchdog()
  }

  async _teardownTorrent () {
    if (!this.torrent) return
    // Stop serving from the old torrent before tearing it down — otherwise
    // in-flight requests read from a destroyed torrent.
    const old = this.torrent
    this.file = null
    this.torrent = null
    await new Promise(r => old.destroy(r))
  }

  /**
   * Resolve when the torrent has metadata, reject if it cannot get it.
   *
   * The bare `once('ready')` this replaces had no way to fail: a swarm with
   * no reachable peers simply never emits, so playback sat on "fetching
   * torrent metadata" indefinitely and — because _switching stayed true —
   * every later request to play something else was silently dropped.
   *
   * 'close' is watched too so abort() unblocks this immediately rather than
   * waiting out the timeout.
   */
  _waitForMetadata (torrent) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        torrent.removeListener('ready', ok)
        torrent.removeListener('error', fail)
        torrent.removeListener('close', onClose)
      }
      const ok = () => { cleanup(); resolve() }
      const fail = err => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))) }
      const onClose = () => fail(new Error('torrent closed'))
      const timer = setTimeout(
        () => fail(new Error(`no metadata within ${METADATA_TIMEOUT_MS}ms`)),
        METADATA_TIMEOUT_MS
      )

      torrent.once('ready', ok)
      torrent.once('error', fail)
      torrent.once('close', onClose)
    })
  }

  /**
   * Abandon whatever is currently starting or playing.
   *
   * The in-flight play() rejects with 'superseded', which the caller is
   * expected to discard — it is not a failure, it is the user picking
   * something else.
   */
  async abort () {
    this._aborted = true
    clearInterval(this._stallTimer)
    this._stallTimer = null
    await this._teardownTorrent()
  }

  /**
   * Add known peers as soon as the torrent has an infoHash (which is
   * what addPeer needs), without waiting for full metadata — the whole
   * point is to be connecting while metadata is still being fetched.
   */
  _injectPeers (torrent, peers) {
    if (!peers.length) return
    const shortlist = peers.slice(0, MAX_INJECTED_PEERS)
    const inject = () => {
      let added = 0
      for (const p of shortlist) {
        if (!p?.host || !p?.port) continue
        try {
          if (torrent.addPeer(`${p.host}:${p.port}`)) added++
        } catch {
          // A single bad address must not abort the rest of the list.
        }
      }
      console.log(`[stream] injected ${added}/${shortlist.length} known peers (of ${peers.length} discovered)`)
    }
    if (torrent.infoHash) inject()
    else torrent.once('infoHash', inject)
  }

  _pickMediaFile (torrent) {
    const VIDEO_EXT = /\.(mp4|mkv|avi|webm|mov|m4v)$/i
    const candidates = torrent.files.filter(f => VIDEO_EXT.test(f.name))
    const pool = candidates.length ? candidates : torrent.files
    return pool.reduce((a, b) => (a.length > b.length ? a : b), pool[0])
  }

  /** Force the first chunk (for the container header) + last chunk
   *  (many MP4s put the moov atom at the end) to download immediately. */
  _prioritizeStart (file) {
    const HEAD_TAIL_BYTES = 2 * 1024 * 1024 // 2MB at each end
    file.select() // mark this file's pieces as wanted at normal priority
    this._selectByteRange(file, 0, Math.min(HEAD_TAIL_BYTES, file.length - 1), true)
    const tailStart = Math.max(0, file.length - HEAD_TAIL_BYTES)
    this._selectByteRange(file, tailStart, file.length - 1, true)
  }

  /** Called by the HTTP handler as playback position becomes known,
   *  so pieces near the playhead jump the queue (deadline-style). */
  prioritizePlayhead (byteOffset, windowBytes = 8 * 1024 * 1024) {
    if (!this.file) return
    const end = Math.min(this.file.length - 1, byteOffset + windowBytes)
    this._selectByteRange(this.file, byteOffset, end, true)
  }

  /**
   * Map a byte range *within the file* to absolute piece indices.
   *
   * Note this uses `file.offset + start`, not `file._startPiece +
   * (start / pieceLength)`. The latter is only correct when the file
   * begins exactly on a piece boundary. In any multi-file torrent it
   * does not: measured on the Sintel torrent (pieceLength 131072), the
   * media file starts at offset 7884, i.e. 7884 bytes into piece 0, and
   * the old formula drifted a full piece behind from byte 258483
   * onward — 28 mismatches sampled across the file. The consequence was
   * that the "critical" window sat one piece behind the playhead, so
   * the player could stall on a piece that was never prioritized.
   */
  _selectByteRange (file, start, end, critical) {
    const pieceLength = file._torrent.pieceLength
    const startPiece = Math.floor((file.offset + start) / pieceLength)
    const endPiece = Math.floor((file.offset + end) / pieceLength)
    if (critical) this.torrent.critical(startPiece, endPiece)
    this.torrent.select(startPiece, endPiece, 1)
  }

  _resetStallWatchdog () {
    clearInterval(this._stallTimer)
    this._lastDownloaded = this.torrent.downloaded
    const startedAt = Date.now()

    this._stallTimer = setInterval(() => {
      if (this._switching || !this.torrent) return

      const bytesSince = this.torrent.downloaded - this._lastDownloaded
      this._lastDownloaded = this.torrent.downloaded

      // Grace period: a fresh torrent legitimately has 0 peers and 0
      // bytes for the first few seconds while it announces and completes
      // handshakes. Measured cold start on a healthy swarm: metadata at
      // ~800ms, 5 peers at ~840ms, but a cold/rare swarm is slower.
      // Failing over during that window discards good candidates.
      if (Date.now() - startedAt < STALL_GRACE_MS) return

      // A finished download has nothing left to pull; that is not a stall.
      if (this.torrent.progress === 1) return

      const healthy = this.torrent.numPeers >= STALL_MIN_PEERS && bytesSince >= STALL_MIN_BYTES_PER_CHECK
      if (healthy) {
        this._strikes = 0
        return
      }

      // Require consecutive bad checks so one momentary lull (a peer
      // churn, a piece-boundary pause) doesn't throw away a swarm that
      // is otherwise fine.
      this._strikes = (this._strikes || 0) + 1
      console.warn(`[stream] swarm quiet (peers=${this.torrent.numPeers}, bytes=${bytesSince}) strike ${this._strikes}/${STALL_STRIKES}`)
      if (this._strikes < STALL_STRIKES) return

      this._strikes = 0
      console.warn('[stream] failing over to next candidate')
      this._advanceToNextCandidate().catch(err => console.error('[stream] failover failed:', err.message))
    }, STALL_CHECK_MS)
  }

  _handleRequest (req, res) {
    if (!this.file) {
      res.writeHead(503)
      return res.end('Not ready yet')
    }
    const file = this.file
    const total = file.length
    const range = req.headers.range

    let start = 0
    let end = total - 1
    if (range) {
      const match = /bytes=(\d+)-(\d+)?/.exec(range)
      if (match) {
        start = parseInt(match[1], 10)
        end = match[2] ? parseInt(match[2], 10) : total - 1
      }
    }

    // Clamp before use: an out-of-range or inverted Range yields a
    // negative Content-Length and a stream the player can never satisfy.
    end = Math.min(end, total - 1)
    if (!Number.isFinite(start) || start < 0 || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      return res.end()
    }

    // A Range request is the strongest signal we have about where the
    // user actually is in playback — use it to reprioritize pieces.
    this.prioritizePlayhead(start)

    res.writeHead(range ? 206 : 200, {
      'Content-Type': mime.lookup(file.name) || 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
    })

    const stream = file.createReadStream({ start, end })
    stream.pipe(res)
    stream.on('error', () => res.end())
    req.on('close', () => stream.destroy())
  }

  /**
   * Public entry point for an embedding HTTP server (the web UI) that
   * serves the video from its own origin instead of making the browser
   * talk to a second listener on another port.
   */
  handleRequest (req, res) {
    return this._handleRequest(req, res)
  }

  async destroy () {
    clearInterval(this._stallTimer)
    if (this.torrent) await new Promise(r => this.torrent.destroy(r))
    await new Promise(r => this.client.destroy(r))
    this.httpServer.close()
  }
}
