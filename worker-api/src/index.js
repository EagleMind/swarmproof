'use strict'

/**
 * Public front door for the engine.
 *
 * There is no API key, deliberately — the same choice the rest of this project
 * makes. What the front door owns instead is *bounding*: the engine behind it
 * will happily open TCP connections to strangers for any infohash it is handed,
 * at any rate, and the box paying for that is one t3.small. So this Worker caps
 * how fast and how much a single caller can ask for, and serves repeat
 * questions from cache rather than from the swarm.
 *
 *   caller ──▶ this Worker ──shared secret──▶ nginx ──▶ engine
 *
 * The shared secret is not user authentication and is not a substitute for it.
 * It exists so that someone who learns the origin address cannot skip the
 * limits by talking to the engine directly; the origin's security group accepts
 * only Cloudflare ranges, so the secret is the second lock rather than the only
 * one.
 */

/**
 * Streaming is deliberately not proxied.
 *
 * `/v1/stream` moves the actual file bytes. Relaying those through a Worker
 * would put a media stream on Cloudflare's network for content the engine
 * fetched from strangers — an AUP problem — and it defeats the point of a
 * peer-to-peer transfer by making the edge the bottleneck. Callers that want
 * bytes should run their own engine.
 */
const BLOCKED = new Set(['/v1/stream', '/v1/play'])

/**
 * Ceiling on candidates per request.
 *
 * Each candidate is a tracker scrape plus a DHT lookup, and on `/v1/assess`
 * real TCP connections to as many as `maxPeers` strangers. One request naming
 * five hundred infohashes is not a use case, it is a way to spend someone
 * else's bandwidth.
 */
const MAX_CANDIDATES = 20

/**
 * Verification is genuinely slow — measured at ~7.6s cold for a single
 * candidate — so the cap has to leave room for the honest case while still
 * bounding the dishonest one.
 */
const MAX_DEADLINE_MS = 30_000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra }
  })

/** Cache key for a POST, since the Cache API only keys on GETs. */
async function cacheKeyFor (url, body) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return new Request(`${url.origin}${url.pathname}?h=${hex}`, { method: 'GET' })
}

/**
 * Reject oversized asks before they reach the engine.
 *
 * Returns an error string, or null when the body is acceptable. Counting
 * candidates means understanding all three input shapes the engine accepts.
 */
function tooLarge (parsed) {
  if (!parsed || typeof parsed !== 'object') return null

  let count = 0
  if (Array.isArray(parsed.candidates)) count = parsed.candidates.length
  else if (typeof parsed.input === 'string') {
    count = parsed.input.split('\n').map(l => l.trim()).filter(Boolean).length
  }

  if (count > MAX_CANDIDATES) {
    return `Too many candidates: ${count}. This endpoint accepts at most ${MAX_CANDIDATES} per request.`
  }
  if (Number(parsed.deadlineMs) > MAX_DEADLINE_MS) {
    return `deadlineMs above the hosted ceiling of ${MAX_DEADLINE_MS}.`
  }
  if (Number(parsed.maxPeers) > 60) {
    return 'maxPeers above the hosted ceiling of 60.'
  }
  return null
}

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // Liveness of the *front door*, answered without waking the origin, so a
    // caller can tell "I am being throttled" from "the service is down".
    if (url.pathname === '/healthz') {
      return json({ ok: true, service: 'swarmproof-api' })
    }

    if (!env.ORIGIN_SECRET || !env.ORIGIN_URL) {
      return json({ error: 'front door is not configured' }, 503)
    }

    if (BLOCKED.has(url.pathname)) {
      return json({
        error: 'not available through the hosted API',
        detail: 'Streaming moves file bytes peer-to-peer and is not relayed through the edge. Run your own engine for /v1/play and /v1/stream.'
      }, 501)
    }

    // No identity to attribute a limit to, so the caller's address is the only
    // handle there is. It is imperfect — one NAT is one bucket — but the
    // alternative is no bound at all.
    const caller = request.headers.get('cf-connecting-ip') || 'unknown'
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: caller })
      if (!success) {
        return json({
          error: 'rate limit exceeded',
          detail: 'Every request here costs real swarm traffic on a single host. Slow down, or run your own engine — it is the same software.'
        }, 429, { 'Retry-After': '60' })
      }
    }

    let rawBody = ''
    if (request.method === 'POST') {
      rawBody = await request.text()
      if (rawBody.length > 64_000) {
        return json({ error: 'body too large' }, 413)
      }
      let parsed = null
      try {
        parsed = rawBody.trim() ? JSON.parse(rawBody) : {}
      } catch {
        return json({ error: 'body is not valid JSON' }, 400)
      }
      const oversized = tooLarge(parsed)
      if (oversized) return json({ error: oversized }, 400)
    }

    // Swarm health moves on the order of minutes, and the engine's own shared
    // health treats anything under two minutes as fresh. A short edge cache is
    // therefore free accuracy-wise and is what keeps a hot infohash from
    // costing one probe per caller.
    const cache = caches.default
    const key = request.method === 'POST'
      ? await cacheKeyFor(url, rawBody)
      : new Request(url.toString(), { method: 'GET' })

    const hit = await cache.match(key)
    if (hit) {
      const headers = new Headers(hit.headers)
      headers.set('x-cache', 'HIT')
      return new Response(hit.body, { status: hit.status, headers })
    }

    const origin = new URL(env.ORIGIN_URL)
    origin.pathname = url.pathname
    origin.search = url.search

    // Rebuilt rather than forwarded: nothing a caller sends may influence the
    // origin secret, and no caller header needs to reach the engine.
    const headers = new Headers({ 'x-engine-secret': env.ORIGIN_SECRET })
    if (request.method === 'POST') headers.set('content-type', 'application/json')

    let upstream
    try {
      upstream = await fetch(origin.toString(), {
        method: request.method,
        headers,
        body: request.method === 'POST' ? rawBody : undefined
      })
    } catch (err) {
      // The engine is one box. Say so plainly rather than returning a shape
      // that looks like an empty result — a caller must never read
      // "unreachable" as "no peers found".
      return json({ error: 'engine unreachable', detail: err.message }, 502)
    }

    const body = await upstream.text()
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'x-cache': 'MISS'
      }
    })

    if (upstream.ok) ctx.waitUntil(cache.put(key, response.clone()))
    return response
  }
}
