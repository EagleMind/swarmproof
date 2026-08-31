'use strict'

// Must come first: it populates process.env for the imports below.
import './env.js'

import http from 'http'

import SwarmScout from './swarmScout.js'
import StreamServer from './streamServer.js'
import { PeerTable } from './peerTable.js'
import { parseInput, PRESETS, makeCandidate } from './catalog.js'

/**
 * The engine as an HTTP service.
 *
 * Everything the library does, reachable from any language over one POST.
 * This is a peer of the library API, not a wrapper around a demo: it holds
 * no logic of its own beyond request shaping, and every route maps onto a
 * SwarmScout or StreamServer call you could make directly.
 *
 * Endpoints are versioned because they are meant to be depended on.
 */

const PORT = Number(process.env.ENGINE_PORT || 8080)

/**
 * No authentication. Deliberate: this is an open tool, and a token on a
 * loopback service is friction with nothing behind it.
 *
 * The one guard that stays is about *where* it listens, which is a different
 * question from who may call it. Bound to 0.0.0.0 this is a BitTorrent client
 * that anyone who finds the port can drive — they choose the infohash, your
 * machine makes the connections and your address is the one in the swarm.
 * Loopback is therefore the default, and going public is one explicit flag
 * rather than a thing that happens because a container passed HOST through.
 *
 *   ENGINE_HOST=0.0.0.0 ENGINE_ALLOW_PUBLIC=1
 */
const HOST = process.env.ENGINE_HOST || '127.0.0.1'
const PUBLIC_OK = /^(1|true|yes)$/i.test(String(process.env.ENGINE_ALLOW_PUBLIC || ''))

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PUBLIC_OK) {
  console.error(
    `\nRefusing to listen on ${HOST}.\n` +
    'Reachable off this machine, this is a torrent client for whoever finds\n' +
    'the port: they pick the content, your IP joins the swarm. If that is\n' +
    'what you want, set ENGINE_ALLOW_PUBLIC=1. Otherwise leave ENGINE_HOST\n' +
    'unset and put a proxy in front.\n')
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

let scout = null
let scoutPromise = null
const stream = new StreamServer()

// One table for the process. Address liveness is a property of the address,
// so every request benefits from what earlier ones learned.
const peerTable = new PeerTable()

const state = { status: 'idle', error: null, decisionMs: null, startedAt: null, requested: [] }

/** Lazily built, and only once even under concurrent first requests. */
function getScout () {
  if (scout) return Promise.resolve(scout)
  if (!scoutPromise) scoutPromise = SwarmScout.create().then(s => { scout = s; return s })
  return scoutPromise
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      // A control API takes magnets, not uploads.
      if (raw.length > 1e6) { req.destroy(); reject(new Error('body too large')) }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * Accepts either shape:
 *   { input: "magnet:?...\n<infohash>" }   newline-separated, what a human pastes
 *   { candidates: [{infoHash, magnetURI, trackers}] }  already built
 *   { presets: true }                      the bundled CC-BY fixtures
 */
function toCandidates (body) {
  if (body.presets) return PRESETS.map(p => makeCandidate(p.label, p.infoHash))
  if (Array.isArray(body.candidates) && body.candidates.length) return body.candidates

  const lines = String(body.input || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) throw new Error('Send { input } with a magnet link or infohash, or { candidates }')
  return lines.map(parseInput)
}

function json (res, code, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(payload)
}

/** Strip the fields a caller has no use for; keep every signal. */
function view (r) {
  return {
    label: r.label,
    infoHash: r.infoHash,
    magnetURI: r.magnetURI,
    verdict: r.verdict,
    verified: r.verified,
    score: r.score,
    source: r.source || 'probed',
    claimed: { seeders: r.sources?.seeders ?? 0, leechers: r.sources?.leechers ?? 0 },
    observed: { peers: r.peers?.length ?? 0, dhtCount: r.sources?.dhtCount ?? 0 },
    weighting: { peerWeight: r.sources?.peerWeight ?? null, locality: r.sources?.locality ?? null },
    meta: r.meta ?? null,
    verifyMs: r.verifyMs ?? null,
    verifyTimedOut: r.verifyTimedOut ?? null,
    error: r.sources?.error ?? null
  }
}

async function play (candidates) {
  state.status = 'ranking'
  state.error = null
  state.startedAt = Date.now()
  state.requested = candidates.map(c => c.label || c.infoHash)
  try {
    const s = await getScout()
    const t0 = Date.now()
    const ranked = await s.rank(candidates)
    state.decisionMs = Date.now() - t0
    state.status = 'starting'
    await stream.play(ranked)
    state.status = 'playing'
  } catch (err) {
    state.status = 'error'
    state.error = err.message
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization'
    })
    return res.end()
  }

  try {
    // Cheap by design: a health check must not build a DHT to answer.
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, status: state.status, scout: Boolean(scout) })
    }

    /** Rank AND verify. The one most callers want. */
    if (url.pathname === '/v1/assess' && req.method === 'POST') {
      const body = await readBody(req)
      const candidates = toCandidates(body)
      const s = await getScout()
      const t0 = Date.now()
      const assessed = await s.assess(candidates, {
        verify: body.verify !== false,
        maxPeers: Number(body.maxPeers) || 40,
        deadlineMs: body.deadlineMs === undefined ? 20000 : Number(body.deadlineMs),
        concurrency: Number(body.concurrency) || 6,
        table: peerTable
      })
      return json(res, 200, {
        elapsedMs: Date.now() - t0,
        candidates: assessed.map(view)
      })
    }

    /** Rank only: no metadata fetch, so ~900ms instead of seconds. */
    if (url.pathname === '/v1/probe' && req.method === 'POST') {
      const candidates = toCandidates(await readBody(req))
      const s = await getScout()
      const t0 = Date.now()
      const ranked = await s.rank(candidates)
      return json(res, 200, {
        elapsedMs: Date.now() - t0,
        candidates: ranked.map(r => view({ ...r, verdict: null, verified: null }))
      })
    }

    /** Start streaming the best candidate. Returns immediately. */
    if (url.pathname === '/v1/play' && req.method === 'POST') {
      const candidates = toCandidates(await readBody(req))
      // Ranking plus metadata takes seconds; the caller polls /v1/status.
      play(candidates).catch(() => {})
      return json(res, 202, { accepted: candidates.map(c => c.label || c.infoHash) })
    }

    if (url.pathname === '/v1/status') {
      const f = stream.file
      const t = stream.torrent
      return json(res, 200, {
        status: state.status,
        error: state.error,
        decisionMs: state.decisionMs,
        requested: state.requested,
        elapsedMs: state.startedAt ? Date.now() - state.startedAt : null,
        cloud: scout?.cloud?.enabled ? scout.cloud.endpoint : null,
        file: f ? { name: f.name, length: f.length } : null,
        torrent: t ? { infoHash: t.infoHash, peers: t.numPeers, downloaded: t.downloaded, progress: t.progress } : null
      })
    }

    /** The bytes, with Range support. */
    if (url.pathname === '/v1/stream') return stream.handleRequest(req, res)

    if (url.pathname === '/v1/presets') return json(res, 200, { presets: PRESETS })

    return json(res, 404, {
      error: 'not found',
      endpoints: [
        'GET  /healthz',
        'POST /v1/assess   { input | candidates | presets }',
        'POST /v1/probe    { input | candidates | presets }',
        'POST /v1/play     { input | candidates | presets }',
        'GET  /v1/status',
        'GET  /v1/stream',
        'GET  /v1/presets'
      ]
    })
  } catch (err) {
    return json(res, 400, { error: err.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`swarm-scout engine on http://${HOST}:${PORT}`)
  console.log(`  POST /v1/assess  - rank and verify`)
  console.log(`  POST /v1/probe   - rank only`)
  console.log(`  POST /v1/play    - stream the winner, then GET /v1/stream`)
})

async function shutdown () {
  server.close()
  try { await stream.destroy() } catch { /* going away anyway */ }
  try { scout?.destroy() } catch { /* going away anyway */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
