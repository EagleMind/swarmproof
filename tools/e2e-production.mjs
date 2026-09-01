#!/usr/bin/env node
//
// End-to-end exercise of the deployed API, over HTTP only.
//
// This is not a unit test and it does not import the engine. It walks the
// same path an integrator walks — bring an infohash, triage it, prove it,
// read the verdict, hit the limits — against whatever is actually deployed.
// Nothing here is mocked; every figure it prints was measured against the
// live BitTorrent network on the far side of the front door.
//
//   node tools/e2e-production.mjs
//   node tools/e2e-production.mjs --api http://127.0.0.1:8080   # your own engine
//   node tools/e2e-production.mjs --rate-limit                  # also burn the 60/min budget
//
// Exit code is the number of failed stages, so CI can gate on it.
//
// One rule shapes the assertions: a stage fails only when the *service* is
// wrong, never when the *swarm* is. A torrent that reports `claimed` today
// may be entirely healthy, so the checks below assert on the contract — the
// shape, the ordering, the ceilings — and report swarm state as measurement.

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const API = (opt('api', 'https://swarmproof-api.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')
const DOCS = (opt('docs', 'https://swarmproof-docs.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')
const CONTROL = (opt('control', 'https://swarmproof-control.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')

// Blender Foundation open movies (CC-BY). Freely redistributable and reliably
// seeded, which is what makes them usable as fixtures: the right answer is
// known in advance, so a wrong one is a bug here rather than a quiet swarm.
const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10'
const BBB = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'
const COSMOS = 'c9e15763f722f23e98a29decdfae341b98d53056'

// Big Buck Bunny's infohash in base32, which BEP 9 permits in a magnet.
const BBB_BASE32 = '3wbfl3g4pssv7mf37ajshwdqmlnr63i4'

const HOSTED = !/127\.0\.0\.1|localhost/.test(API)

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const results = []
let stage = ''

const heading = title => {
  stage = title
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

function record (name, ok, detail = '') {
  results.push({ stage, name, ok })
  const mark = ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'
  console.log(`${mark} ${name.padEnd(42)}${detail}`)
}

/** A measurement, not an assertion — printed but never failed on. */
function observe (name, detail) {
  console.log(`\x1b[90m   ·   ${name.padEnd(42)}${detail}\x1b[0m`)
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

async function call (path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const t0 = Date.now()
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* some routes answer in plain text */ }
  return { status: res.status, headers: res.headers, json, text, ms: Date.now() - t0 }
}

/** Stay under the hosted 60/min. Skipped entirely against a local engine. */
const pace = () => HOSTED ? new Promise(r => setTimeout(r, 1200)) : Promise.resolve()

/* ------------------------------------------------------------------ *
 * 1. Is anything there
 * ------------------------------------------------------------------ */

heading('1. Reachability')

{
  const r = await call('/healthz')
  record('front door answers', r.status === 200, `${r.status} in ${r.ms}ms`)

  // The front door answers /healthz without waking the origin, on purpose:
  // it lets a caller tell "I am being throttled" from "the service is down".
  if (HOSTED) {
    record('healthz needs no origin', r.json?.ok === true, JSON.stringify(r.json))
  }
}

/* ------------------------------------------------------------------ *
 * 2. Input shapes
 * ------------------------------------------------------------------ */

heading('2. Input shapes the API accepts')

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { presets: true } })
  const ok = r.status === 200 && Array.isArray(r.json?.candidates) && r.json.candidates.length === 4
  record('{ presets: true }', ok, `${r.json?.candidates?.length ?? 0} candidates in ${r.ms}ms`)

  // Ranked best-first, and every candidate is returned — including zeros — so
  // a caller applies its own cutoff rather than inheriting one.
  if (ok) {
    const scores = r.json.candidates.map(c => c.score)
    const sorted = [...scores].every((v, i, a) => i === 0 || a[i - 1] >= v)
    record('returned best-first', sorted, scores.join(' > '))
  }
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { input: SINTEL } })
  record('{ input } bare infohash', r.status === 200 && r.json?.candidates?.[0]?.infoHash === SINTEL)
}

{
  await pace()
  const magnet = `magnet:?xt=urn:btih:${BBB}&dn=Big+Buck+Bunny`
  const r = await call('/v1/probe', { method: 'POST', body: { input: magnet } })
  record('{ input } magnet link', r.status === 200 && r.json?.candidates?.[0]?.infoHash === BBB)
}

{
  await pace()
  // A base32 xt= must be decoded to the same hex a hex magnet would yield.
  // Left undecoded it produces a 32-char string the DHT and trackers cannot use.
  const r = await call('/v1/probe', { method: 'POST', body: { input: `magnet:?xt=urn:btih:${BBB_BASE32}&dn=BBB` } })
  const got = r.json?.candidates?.[0]?.infoHash
  record('base32 magnet decodes to hex', got === BBB, got || r.text.slice(0, 60))
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { candidates: [{ infoHash: COSMOS, label: 'Cosmos' }] } })
  record('{ candidates } pre-built', r.status === 200 && r.json?.candidates?.[0]?.label === 'Cosmos')
}

/* ------------------------------------------------------------------ *
 * 3. Triage
 * ------------------------------------------------------------------ */

heading('3. Triage — /v1/probe')

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { presets: true } })
  const ok = r.status === 200
  record('ranks without verifying', ok && r.json.candidates.every(c => c.verdict === null),
    'verdict is null by design')

  if (ok) {
    for (const c of r.json.candidates) {
      observe(c.label, `score=${String(c.score).padEnd(6)} claimed=${c.claimed.seeders}s/${c.claimed.leechers}l ` +
        `observed=${c.observed.peers}p dht=${c.observed.dhtCount} source=${c.source}`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. Proof
 * ------------------------------------------------------------------ */

heading('4. Proof — /v1/assess')

const proven = []

for (const [label, ih] of [['Sintel', SINTEL], ['Big Buck Bunny', BBB], ['Cosmos Laundromat', COSMOS]]) {
  await pace()
  const r = await call('/v1/assess', { method: 'POST', body: { input: ih, deadlineMs: 28000 }, timeoutMs: 90000 })
  const c = r.json?.candidates?.[0]

  record(`${label} returns a verdict`, r.status === 200 && !!c?.verdict, c ? `${c.verdict} in ${r.ms}ms` : r.text.slice(0, 80))
  if (!c) continue
  proven.push(c)

  observe('', `peers=${c.observed.peers} verifyMs=${c.verifyMs} timedOut=${c.verifyTimedOut} source=${c.source}`)

  // Verification must never be answered from shared health. The control plane
  // deliberately stores no peer lists, so a shared answer arrives with peers: []
  // and the verdict collapses to `claimed` — a real swarm reported unprovable.
  record(`${label} probed, not shared`, c.source === 'probed', `source=${c.source}`)

  // meta is the torrent itself, pulled from a peer and checked against the
  // infohash. It is the one field that cannot be a different file.
  if (c.verdict === 'verified') {
    const hasMeta = !!c.meta?.name && c.meta.size > 0
    record(`${label} carries proven metadata`, hasMeta, hasMeta ? `${c.meta.name} · ${c.meta.size} bytes · ${c.meta.files} files` : 'meta missing')
  } else {
    // Not a failure of the service. A swarm can be genuinely unprovable right
    // now, and saying so is the honest answer.
    observe('', `not verified this run — ${c.verdict}. See verifyTimedOut above.`)
  }
}

/* ------------------------------------------------------------------ *
 * 5. Verdict contract
 * ------------------------------------------------------------------ */

heading('5. Verdict contract')

{
  const VERDICTS = ['verified', 'reachable', 'claimed', 'none']
  record('verdicts are from the known set',
    proven.every(c => VERDICTS.includes(c.verdict)),
    proven.map(c => c.verdict).join(', '))

  record('verified implies verified:true',
    proven.every(c => (c.verdict === 'verified') === (c.verified === true)))

  // claimed and observed are different instruments and must stay separable:
  // conflating them is how a hash that does not exist gets a green badge.
  record('claims and proof stay separate fields',
    proven.every(c => c.claimed && c.observed &&
      typeof c.claimed.seeders === 'number' && typeof c.observed.peers === 'number'))

  await pace()
  const r = await call('/v1/assess', { method: 'POST', body: { presets: true, verify: true, deadlineMs: 28000 }, timeoutMs: 120000 })
  if (r.status === 200) {
    const tier = { verified: 0, reachable: 1, claimed: 2, none: 3 }
    const seq = r.json.candidates.map(c => tier[c.verdict])
    const ordered = seq.every((v, i, a) => i === 0 || a[i - 1] <= v)
    // Nothing unproven may outrank something proven, whatever its score.
    record('sorted by verdict tier, then score', ordered,
      r.json.candidates.map(c => `${c.verdict}:${c.score}`).join(' > '))
  } else {
    record('sorted by verdict tier, then score', false, `HTTP ${r.status}`)
  }
}

/* ------------------------------------------------------------------ *
 * 6. Ceilings and failure modes
 * ------------------------------------------------------------------ */

heading(HOSTED ? '6. Hosted ceilings and failure modes' : '6. Failure modes (self-hosted: no ceilings)')

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { input: 'not-a-magnet-or-infohash' } })
  record('rejects unusable input', r.status === 400 && !!r.json?.error, r.json?.error || r.status)
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: 'x', timeoutMs: 20000 }).catch(e => ({ status: 0, text: e.message }))
  // Sent as a JSON string rather than an object: still valid JSON, but not a
  // shape carrying candidates.
  record('rejects a body with no candidates', r.status === 400, `HTTP ${r.status}`)
}

if (HOSTED) {
  {
    await pace()
    const many = Array(25).fill(BBB).join('\n')
    const r = await call('/v1/probe', { method: 'POST', body: { input: many } })
    record('caps candidates per request', r.status === 400 && /Too many candidates/.test(r.json?.error || ''), r.json?.error)
  }

  {
    await pace()
    const r = await call('/v1/assess', { method: 'POST', body: { input: SINTEL, maxPeers: 500 } })
    record('caps maxPeers', r.status === 400 && /maxPeers/.test(r.json?.error || ''), r.json?.error)
  }

  {
    await pace()
    const r = await call('/v1/assess', { method: 'POST', body: { input: SINTEL, deadlineMs: 900000 } })
    record('caps deadlineMs', r.status === 400 && /deadlineMs/.test(r.json?.error || ''), r.json?.error)
  }

  {
    const r = await call('/v1/stream')
    record('/v1/stream is 501, not proxied', r.status === 501, r.json?.error)
  }

  {
    await pace()
    const r = await call('/v1/play', { method: 'POST', body: { presets: true } })
    record('/v1/play is 501, not proxied', r.status === 501, r.json?.error)
  }
}

/* ------------------------------------------------------------------ *
 * 7. Caching
 * ------------------------------------------------------------------ */

if (HOSTED) {
  heading('7. Edge cache')

  // Keyed on a hash of the body, so an identical question is answered without
  // costing the origin another trip into the swarm. 60s, which sits inside the
  // two-minute window the engine itself treats as fresh.
  const body = { input: COSMOS }
  await pace()
  const first = await call('/v1/probe', { method: 'POST', body })
  const second = await call('/v1/probe', { method: 'POST', body })

  record('identical query is cached',
    second.headers.get('x-cache') === 'HIT',
    `first=${first.headers.get('x-cache')} (${first.ms}ms) second=${second.headers.get('x-cache')} (${second.ms}ms)`)

  // Must be a body this run has not sent before, and no earlier stage has
  // either — the key is a hash of the body, so reusing a fixture here would
  // legitimately HIT and the check would be testing the test. A per-run
  // nonexistent hash is unique by construction and costs no real swarm
  // traffic, since there is nothing out there to find.
  await pace()
  const unique = Date.now().toString(16).padStart(40, '0').slice(-40)
  const other = await call('/v1/probe', { method: 'POST', body: { input: unique } })
  record('an unseen query is not', other.headers.get('x-cache') === 'MISS', `x-cache=${other.headers.get('x-cache')}`)
}

/* ------------------------------------------------------------------ *
 * 8. Rate limit — opt-in, because passing it costs the whole minute
 * ------------------------------------------------------------------ */

if (HOSTED && flag('rate-limit')) {
  heading('8. Rate limit')

  let sawLimit = false
  let sent = 0
  // Vary the body so the edge cache cannot answer these without consulting
  // the limiter, and use a nonexistent-but-valid hash so no real swarm is hit.
  for (let i = 0; i < 80 && !sawLimit; i++) {
    const hash = i.toString(16).padStart(40, '0')
    const r = await call('/v1/probe', { method: 'POST', body: { input: hash }, timeoutMs: 30000 })
    sent++
    if (r.status === 429) {
      sawLimit = true
      record('429 after the budget', true, `after ${sent} requests · Retry-After=${r.headers.get('retry-after')}`)
    }
  }
  if (!sawLimit) record('429 after the budget', false, `no 429 in ${sent} requests`)
  console.log('\x1b[90m   ·   budget is spent for this minute; later stages may 429\x1b[0m')
} else if (HOSTED) {
  console.log('\n\x1b[90m8. Rate limit — skipped. Pass --rate-limit to exercise it.\x1b[0m')
}

/* ------------------------------------------------------------------ *
 * 9. The rest of the deployment
 * ------------------------------------------------------------------ */

if (HOSTED) {
  heading('9. Supporting services')

  {
    const r = await fetch(`${DOCS}/openapi.json`, { signal: AbortSignal.timeout(20000) })
    const spec = await r.json().catch(() => null)
    record('docs serve the spec', r.status === 200 && spec?.openapi === '3.1.0', spec?.info?.title)
    record('spec points at this API', spec?.servers?.[0]?.url === API, spec?.servers?.[0]?.url)

    // Every route the spec advertises should exist on the deployment it names.
    const advertised = Object.keys(spec?.paths || {})
    record('spec advertises the routes tested here',
      ['/v1/assess', '/v1/probe', '/v1/status', '/healthz'].every(p => advertised.includes(p)),
      advertised.join(' '))
  }

  {
    const r = await fetch(`${CONTROL}/v1/status`, { signal: AbortSignal.timeout(20000) })
    const st = await r.json().catch(() => null)
    record('control plane answers', r.status === 200 && st !== null,
      st ? `health=${st.healthEntries} contributions=${st.liveContributions} pool=${st.pool?.nodes}` : '')

    // Empty is not broken: health carries a 900s TTL and contributions a 30min
    // one, so an idle deployment legitimately reports zeros.
    if (st && st.healthEntries === 0) {
      observe('', 'no health entries — expected if nothing has ranked in the last 15 minutes')
    }
  }
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const failed = results.filter(r => !r.ok)
console.log(`\n${'─'.repeat(64)}`)
console.log(`${results.length - failed.length}/${results.length} checks passed against ${API}`)

if (failed.length) {
  console.log('\n\x1b[31mFailed:\x1b[0m')
  for (const f of failed) console.log(`  ${f.stage} → ${f.name}`)
}

const verified = proven.filter(c => c.verdict === 'verified').length
console.log(`\n${verified}/${proven.length} fixtures proved alive by pulling the torrent from a peer.`)
if (verified < proven.length) {
  console.log('A fixture that did not verify is not necessarily a failure — read verdict and')
  console.log('verifyTimedOut together before concluding anything about the swarm.')
}

process.exit(failed.length)
