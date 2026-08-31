'use strict'

// Must come first: it populates process.env for the imports below.
import '../env.js'

import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import SwarmScout from '../swarmScout.js'
import StreamServer from '../streamServer.js'
import { parseInput, PRESETS, makeCandidate } from '../catalog.js'
import { DhtCrawler } from '../dhtCrawler.js'

/**
 * A test console for the discovery layer.
 *
 * This is not an application. It exists because staring at CLI output is a
 * poor way to watch three asynchronous network subsystems — a tracker
 * scrape, a DHT lookup and a BEP-51 crawl — behave differently from one run
 * to the next. Everything here is a window onto swarmScout.js,
 * dhtCrawler.js and streamServer.js; none of it holds logic of its own.
 *
 * The one thing it does that a CLI cannot: show the probe and the crawl
 * side by side while both are running, which is where the interesting
 * failures live.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.UI_PORT || 8080)

/**
 * Where to listen.
 *
 * Loopback by default. A previous version's `listen(PORT)` bound every
 * interface, which is harmless behind a home router and dangerous the
 * moment this runs on a VPS — combined with `Access-Control-Allow-Origin: *`
 * and no authentication, it handed anyone who found the port a
 * remote-controlled BitTorrent client running as you.
 *
 * Opening it up is now a deliberate act: set ENGINE_HOST=0.0.0.0, which
 * refuses to start without a token.
 */
const HOST = process.env.ENGINE_HOST || '127.0.0.1'

/**
 * Shared secret for remote access.
 *
 * Accepted as `Authorization: Bearer …` or `?token=…`. The query form exists
 * because a <video> element cannot set headers, and the stream endpoint has
 * to be reachable by the browser's own media loader.
 */
const TOKEN = (process.env.ENGINE_TOKEN || '').trim()

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error(
    `\nRefusing to listen on ${HOST} without ENGINE_TOKEN.\n` +
    'An engine reachable off this machine and open to anyone is a remote\n' +
    'torrent client for whoever finds the port. Set ENGINE_TOKEN to a long\n' +
    'random string, or leave ENGINE_HOST unset to stay on loopback.\n')
  process.exit(1)
}

/** Constant-time compare, so a wrong token cannot be found byte by byte. */
function tokenValid (given) {
  if (!TOKEN) return true
  if (!given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function authorized (req, url) {
  if (!TOKEN) return true
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null
  return tokenValid(bearer || url.searchParams.get('token'))
}

/** Containers a <video> tag can actually decode. MKV/AVI need an external
 *  player, so the console offers the stream URL for VLC/mpv instead of a
 *  dead black rectangle. */
const BROWSER_PLAYABLE = /\.(mp4|m4v|webm)$/i

const state = {
  status: 'idle', // idle | ranking | starting | playing | error
  error: null,
  decisionMs: null,
  ranked: [],
  requested: null,
  startedAt: null
}

let scout = null
const stream = new StreamServer()

// StreamServer builds an http.Server it only listens on in standalone mode.
// Here the console owns the listener and delegates to handleRequest(), so
// the unused one must not be left without an error handler.
stream.httpServer.on('error', () => {})

/**
 * The playback currently starting, and a counter identifying it.
 *
 * Only one attempt may touch the StreamServer at a time, but a newer request
 * must be able to replace an older one rather than be refused — see play().
 * Every async step checks its generation before writing to `state`, so a
 * superseded run cannot resurrect stale status or a stale ranking.
 */
let inFlight = null
let generation = 0

async function getScout () {
  if (!scout) scout = await SwarmScout.create()
  return scout
}

/* ------------------------------------------------------------------ *
 * Probing — the part this console actually exists for
 * ------------------------------------------------------------------ */

/**
 * The last probe, kept so the page can redraw without re-running it.
 *
 * A probe costs a tracker scrape and a DHT lookup per candidate; a page
 * refresh should not spend that again.
 */
let lastProbe = null

/**
 * Rank candidates and report, without streaming anything.
 *
 * This is discovery in isolation — "which of these swarms is alive"
 * answered on its own, with the per-candidate signals that produced the
 * answer surfaced rather than collapsed into a single score. Playback is a
 * separate, optional step; see play().
 */
async function probe (candidates) {
  const s = await getScout()
  const t0 = Date.now()
  const ranked = await s.rank(candidates)
  const elapsedMs = Date.now() - t0

  lastProbe = {
    at: Date.now(),
    elapsedMs,
    candidates: ranked.map(r => ({
      label: r.label,
      infoHash: r.infoHash,
      magnetURI: r.magnetURI,
      score: r.score,
      // 'probed' means it paid for a live tracker scrape and DHT lookup;
      // 'shared' means the control plane already knew. Worth showing: a
      // fast decision and a well-founded one are not the same claim.
      source: r.source || 'probed',
      seeders: r.sources?.seeders ?? 0,
      leechers: r.sources?.leechers ?? 0,
      dhtCount: r.sources?.dhtCount ?? 0,
      peerCount: r.peers?.length ?? 0,
      // How the score departed from the raw counts, so a ranking that
      // disagrees with "more seeders wins" is explainable. See locality.js.
      peerWeight: r.sources?.peerWeight ?? null,
      locality: r.sources?.locality ?? null,
      via: r.sources?.via ?? null,
      fromCache: Boolean(r.sources?.fromCache),
      error: r.sources?.error ?? null
    }))
  }
  return lastProbe
}

/* ------------------------------------------------------------------ *
 * Playback — verification that a ranked swarm is real
 * ------------------------------------------------------------------ */

async function startPlayback (candidates, gen) {
  const current = () => gen === generation

  const s = await getScout()
  const t0 = Date.now()
  const ranked = await s.rank(candidates)
  if (!current()) return

  state.decisionMs = Date.now() - t0
  state.ranked = ranked.map(r => ({
    label: r.label,
    infoHash: r.infoHash,
    score: r.score,
    source: r.source,
    seeders: r.sources?.seeders ?? 0,
    leechers: r.sources?.leechers ?? 0,
    dhtCount: r.sources?.dhtCount ?? 0
  }))

  state.status = 'starting'
  await stream.play(ranked)
  if (!current()) return
  state.status = 'playing'
}

/**
 * Start playback, superseding anything already in flight.
 *
 * An earlier version rejected a second request outright, which was wrong in
 * exactly the case that matters: if the first candidate stalled fetching
 * metadata, every subsequent click was silently dropped and the page kept
 * showing the stalled candidate's status and ranking. Picking something else
 * is a normal thing to do, so the newest request always wins — the older one
 * is aborted, and its late results are discarded by the generation check.
 */
function play (candidates) {
  const gen = ++generation
  const previous = inFlight

  // Reset visible state immediately so the console stops showing the old
  // ranking while the new candidates are still being probed.
  state.status = 'ranking'
  state.error = null
  state.ranked = []
  state.decisionMs = null
  state.requested = candidates.map(c => c.label)
  state.startedAt = Date.now()

  const run = (async () => {
    if (previous) {
      await stream.abort().catch(() => {})
      await previous.catch(() => {})
    }
    // A third request may have arrived while we were tearing down.
    if (gen !== generation) return
    await startPlayback(candidates, gen)
  })()

  inFlight = run
    .catch(err => {
      // A superseded run is not a failure the user needs to see.
      if (gen !== generation) return
      state.status = 'error'
      state.error = err.message
    })
    .finally(() => { if (gen === generation) inFlight = null })

  return inFlight
}

/* ------------------------------------------------------------------ *
 * The crawler
 * ------------------------------------------------------------------ */

let crawler = null

/**
 * Start the BEP 51 crawl.
 *
 * No torrent client is involved any more. The crawler speaks the three
 * protocols it needs directly — sample_infohashes and get_peers over the
 * scout's DHT socket, ut_metadata over its own short-lived TCP connections —
 * so there is nothing here to construct but the crawler itself.
 *
 * This also retires an earlier hazard worth not rediscovering: handing a
 * WebTorrent client the scout's DHT instance pegged a full core and starved
 * the event loop within a minute. With no client in the picture, the
 * contention has nowhere to come from.
 */
async function getCrawler () {
  if (crawler) return crawler
  const s = await getScout()
  crawler = new DhtCrawler({ dht: s.dht })
  return crawler
}

function crawlerView () {
  if (!crawler) return { started: false, running: false }
  const c = crawler.counts()
  return {
    started: true,
    running: crawler.running,
    ...c,
    // Sampling and naming are separate stages with separate failure modes,
    // and a rising "sampled" count looks like progress even when naming is
    // returning nothing at all. Reported apart, on purpose.
    sampled: crawler.stats.sampled,
    queried: crawler.stats.queried,
    errors: crawler.stats.errors,
    queued: crawler.queue.length,
    // The middle stage, which is where a hash either acquires a peer to ask
    // or is cheaply written off. Watching hits against misses says whether
    // the crawl is finding live swarms or harvesting dead ones.
    leads: crawler.stats.leads,
    peerHits: crawler.stats.peerHits,
    peerMisses: crawler.stats.peerMisses,
    metaAttempts: crawler.stats.metaAttempts,
    leadQueue: crawler.leads.length,
    metaQueue: crawler.pendingMeta.length
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * Routing-table size is the honest measure of DHT health, not `ready`.
 *
 * `ready` fires only after a full bootstrap populate pass — measured at
 * ~5.5s — while the table holds usable nodes within ~84ms and lookups work
 * fine against it. A console that showed only `ready` would report a
 * working DHT as down for five seconds. See swarmScout._probePeers.
 */
function dhtView () {
  if (!scout?.dht) return { up: false, ready: false, nodes: 0 }
  let nodes = 0
  try { nodes = (scout.dht.toJSON().nodes || []).length } catch { /* mid-teardown */ }
  return { up: true, ready: Boolean(scout.dht.ready), nodes }
}

function snapshot () {
  const t = stream.torrent
  const f = stream.file
  const active = stream.rankedCandidates?.[stream.candidateIndex] || null

  return {
    status: state.status,
    error: state.error,
    decisionMs: state.decisionMs,
    ranked: state.ranked,
    requested: state.requested,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : null,
    dht: dhtView(),
    cloud: scout?.cloud?.enabled ? scout.cloud.endpoint : null,
    crawler: crawlerView(),
    active: active ? { index: stream.candidateIndex, label: active.label, score: active.score } : null,
    file: f ? { name: f.name, length: f.length, playable: BROWSER_PLAYABLE.test(f.name) } : null,
    torrent: t
      ? {
          peers: t.numPeers,
          progress: t.progress,
          downloaded: t.downloaded,
          downloadSpeed: t.downloadSpeed,
          uploadSpeed: t.uploadSpeed,
          ratio: t.ratio
        }
      : null
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function json (res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      // A control endpoint has no business accepting megabytes.
      if (raw.length > 64 * 1024) reject(new Error('Body too large'))
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('Body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * Turn the request into a candidate list.
 *
 * Multiple magnets are treated as alternate copies of the SAME content,
 * which is the case this exists for: rank them, stream the healthiest, fail
 * over to the next if it dies. `presets: true` substitutes the known-good
 * test swarms, whose relative health is known in advance.
 */
function toCandidates (body) {
  if (body.presets) return PRESETS.map(p => makeCandidate(p.label, p.infoHash))

  const lines = String(body.input || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) throw new Error('Paste a magnet link or an infohash')
  return lines.map(parseInput)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // The engine binds loopback by default and holds nothing private, so a
  // wildcard is the honest answer. Off-machine access is gated by TOKEN.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' })
    return res.end()
  }

  try {
    if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' })

    if (url.pathname === '/video') return stream.handleRequest(req, res)

    if (url.pathname === '/api/status') return json(res, 200, snapshot())

    if (url.pathname === '/api/presets') return json(res, 200, { presets: PRESETS })

    /** Probe without playing: discovery on its own. */
    if (url.pathname === '/api/probe' && req.method === 'POST') {
      return json(res, 200, await probe(toCandidates(await readBody(req))))
    }

    if (url.pathname === '/api/probe') {
      return json(res, 200, lastProbe || { at: null, elapsedMs: null, candidates: [] })
    }

    if (url.pathname === '/api/play' && req.method === 'POST') {
      const candidates = toCandidates(await readBody(req))
      // Don't await the stream — ranking plus metadata takes seconds and the
      // page wants to start polling /api/status immediately.
      play(candidates).catch(() => {})
      return json(res, 202, { accepted: candidates.map(c => c.label) })
    }

    if (url.pathname === '/api/crawler' && req.method === 'GET') {
      return json(res, 200, crawlerView())
    }

    if (url.pathname === '/api/crawler/start' && req.method === 'POST') {
      ;(await getCrawler()).start()
      return json(res, 202, crawlerView())
    }

    if (url.pathname === '/api/crawler/stop' && req.method === 'POST') {
      crawler?.stop()
      return json(res, 200, crawlerView())
    }

    /** Search names the crawl has resolved. Empty until naming works. */
    if (url.pathname === '/api/crawler/search') {
      const q = url.searchParams.get('q') || ''
      return json(res, 200, { query: q, results: (await getCrawler()).search(q) })
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    json(res, 404, { error: 'Not found' })
  } catch (err) {
    json(res, 400, { error: err.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`\n  swarm-scout console  →  http://localhost:${PORT}\n`)
})

process.on('SIGINT', async () => {
  console.log('\nshutting down...')
  try { crawler?.close() } catch { /* already closed */ }
  try { await stream.destroy() } catch { /* already gone */ }
  scout?.destroy()
  process.exit(0)
})
