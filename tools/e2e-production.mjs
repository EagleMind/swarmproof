#!/usr/bin/env node
//
// End-to-end exercise of the deployed API, over HTTP only.
//
// This is not a unit test and it does not import the engine. It walks the
// same path an integrator walks — bring an infohash, triage it, prove it,
// read the verdict, hit the limits — against whatever is actually deployed,
// and logs the full wire trace: every request, every response body, the
// status, and the latency. Nothing is mocked; every figure it prints was
// measured against the live BitTorrent network on the far side of the door.
//
//   npm run e2e
//   node tools/e2e-production.mjs --api http://127.0.0.1:8080   # your own engine
//   node tools/e2e-production.mjs --compact                     # elide long bodies
//   node tools/e2e-production.mjs --rate-limit                  # burn the 60/min budget
//   node tools/e2e-production.mjs --no-color > run.log          # for a file or CI
//
// Exit code is the number of failed checks, so CI can gate on it.
//
// One rule shapes the assertions: a check fails only when the *service* is
// wrong, never when the *swarm* is. A torrent that reports `claimed` today
// may be entirely healthy, so the checks assert on the contract — shape,
// ordering, ceilings — and swarm state is logged as measurement.

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const API = (opt('api', 'https://swarmproof-api.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')
const DOCS = (opt('docs', 'https://swarmproof-docs.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')
const CONTROL = (opt('control', 'https://swarmproof-control.hassen-ben-mbarek.workers.dev')).replace(/\/+$/, '')

const COMPACT = flag('compact')
const BODY_LIMIT = Number(opt('max-body', COMPACT ? 300 : 100000))

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
 * Output
 * ------------------------------------------------------------------ */

const COLOR = !flag('no-color') && process.stdout.isTTY !== false
const c = COLOR
  ? { dim: s => `\x1b[90m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m` }
  : { dim: s => s, bold: s => s, green: s => s, red: s => s, cyan: s => s, yellow: s => s }

const results = []
const timings = []
let stage = ''
let seq = 0

const heading = title => {
  stage = title
  console.log(`\n${c.bold('━'.repeat(72))}`)
  console.log(c.bold(title))
  console.log(c.bold('━'.repeat(72)))
}

/** Indent a multi-line body so it reads as one block under its label. */
function block (label, text) {
  if (text === undefined || text === null || text === '') return
  const clipped = text.length > BODY_LIMIT
    ? text.slice(0, BODY_LIMIT) + `\n… ${text.length - BODY_LIMIT} more chars (raise with --max-body)`
    : text
  const lines = clipped.split('\n')
  console.log(c.dim(`     ${label.padEnd(9)}`) + lines[0])
  for (const l of lines.slice(1)) console.log(' '.repeat(14) + l)
}

function record (name, ok, detail = '') {
  results.push({ stage, name, ok })
  const mark = ok ? c.green('  ✓ PASS') : c.red('  ✗ FAIL')
  console.log(`${mark}  ${name}${detail ? c.dim('  — ' + detail) : ''}`)
}

/** A measurement, not an assertion — logged but never failed on. */
function observe (name, detail = '') {
  console.log(c.dim(`  · ${name}${detail ? '  ' + detail : ''}`))
}

/** Status codes colour by class so a 4xx/5xx is visible while scrolling. */
const paintStatus = s =>
  s >= 500 ? c.red(String(s)) : s >= 400 ? c.yellow(String(s)) : s >= 200 && s < 300 ? c.green(String(s)) : String(s)

/* ------------------------------------------------------------------ *
 * Transport — every call is logged in full
 * ------------------------------------------------------------------ */

// Response headers worth seeing on every call. The rest are noise here.
const INTERESTING = ['content-type', 'x-cache', 'cache-control', 'retry-after', 'cf-ray']

async function request (url, { method = 'GET', body, timeoutMs = 60000, label = '' } = {}) {
  const n = ++seq
  const path = url.replace(/^https?:\/\/[^/]+/, '') || '/'
  const host = url.replace(/^(https?:\/\/[^/]+).*$/, '$1')

  console.log('')
  console.log(`  ${c.cyan(`[${String(n).padStart(2, '0')}] → ${method} ${path}`)}${label ? c.dim('   ' + label) : ''}`)
  console.log(c.dim(`     host      ${host}`))
  if (body !== undefined) block('request', typeof body === 'string' ? body : JSON.stringify(body))

  const t0 = Date.now()
  let res, text, err = null
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeoutMs)
    })
    text = await res.text()
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t0
  timings.push({ n, method, path, ms, status: res?.status ?? 0 })

  if (err) {
    console.log(`     ${c.dim('status')}    ${c.red('NO RESPONSE')}   ${c.dim('latency')} ${ms}ms`)
    block('error', err.message)
    return { status: 0, headers: new Headers(), json: null, text: '', ms, error: err }
  }

  const hdrs = INTERESTING
    .map(h => [h, res.headers.get(h)])
    .filter(([, v]) => v)
    .map(([h, v]) => `${h}=${v}`)
    .join('  ')

  console.log(`     ${c.dim('status')}    ${paintStatus(res.status)} ${res.statusText || ''}   ${c.dim('latency')} ${c.bold(ms + 'ms')}`)
  if (hdrs) console.log(c.dim(`     headers   ${hdrs}`))

  let json = null
  try { json = JSON.parse(text) } catch { /* some routes answer in plain text */ }
  block('response', json ? JSON.stringify(json, null, 2) : text)

  return { status: res.status, headers: res.headers, json, text, ms }
}

const call = (path, opts) => request(API + path, opts)

/** Stay under the hosted 60/min. Skipped entirely against a local engine. */
const pace = () => HOSTED ? new Promise(r => setTimeout(r, 1200)) : Promise.resolve()

/* ------------------------------------------------------------------ *
 * Preamble
 * ------------------------------------------------------------------ */

console.log(c.bold('\nswarmproof — end-to-end production check'))
console.log(c.dim(`api      ${API}`))
console.log(c.dim(`docs     ${DOCS}`))
console.log(c.dim(`control  ${CONTROL}`))
console.log(c.dim(`mode     ${HOSTED ? 'hosted (ceilings enforced)' : 'self-hosted (no ceilings)'}${COMPACT ? ' · compact bodies' : ''}`))
console.log(c.dim(`started  ${new Date().toISOString()}`))

/* ------------------------------------------------------------------ *
 * 1. Is anything there
 * ------------------------------------------------------------------ */

heading('1. Reachability')

{
  const r = await call('/healthz', { label: 'front door liveness' })
  record('front door answers', r.status === 200, `${r.status} in ${r.ms}ms`)

  // The front door answers /healthz without waking the origin, on purpose:
  // it lets a caller tell "I am being throttled" from "the service is down".
  if (HOSTED) record('healthz needs no origin', r.json?.ok === true, `service=${r.json?.service}`)
}

/* ------------------------------------------------------------------ *
 * 2. Input shapes
 * ------------------------------------------------------------------ */

heading('2. Input shapes the API accepts')

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { presets: true }, label: 'bundled CC-BY fixtures' })
  const ok = r.status === 200 && r.json?.candidates?.length === 4
  record('{ presets: true }', ok, `${r.json?.candidates?.length ?? 0} candidates in ${r.ms}ms`)

  // Ranked best-first, and every candidate is returned — including zeros — so
  // a caller applies its own cutoff rather than inheriting one.
  if (ok) {
    const scores = r.json.candidates.map(x => x.score)
    record('returned best-first', scores.every((v, i, a) => i === 0 || a[i - 1] >= v), scores.join(' ≥ '))
  }
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { input: SINTEL }, label: 'bare 40-char infohash' })
  record('{ input } bare infohash', r.status === 200 && r.json?.candidates?.[0]?.infoHash === SINTEL)
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { input: `magnet:?xt=urn:btih:${BBB}&dn=Big+Buck+Bunny` }, label: 'hex magnet' })
  record('{ input } magnet link', r.status === 200 && r.json?.candidates?.[0]?.infoHash === BBB)
}

{
  await pace()
  // A base32 xt= must be decoded to the same hex a hex magnet would yield.
  // Left undecoded it produces a 32-char string the DHT and trackers cannot use.
  const r = await call('/v1/probe', { method: 'POST', body: { input: `magnet:?xt=urn:btih:${BBB_BASE32}&dn=BBB` }, label: 'base32 magnet — must decode to hex' })
  const got = r.json?.candidates?.[0]?.infoHash
  record('base32 magnet decodes to hex', got === BBB, `${BBB_BASE32} → ${got}`)
}

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { candidates: [{ infoHash: COSMOS, label: 'Cosmos' }] }, label: 'pre-built candidate' })
  record('{ candidates } pre-built', r.status === 200 && r.json?.candidates?.[0]?.label === 'Cosmos')
}

/* ------------------------------------------------------------------ *
 * 3. Triage
 * ------------------------------------------------------------------ */

heading('3. Triage — /v1/probe')

{
  await pace()
  const r = await call('/v1/probe', { method: 'POST', body: { presets: true }, label: 'rank only, no peer connections' })
  const ok = r.status === 200
  record('ranks without verifying', ok && r.json.candidates.every(x => x.verdict === null), 'verdict is null by design')

  if (ok) {
    console.log('')
    for (const x of r.json.candidates) {
      observe(x.label.padEnd(20),
        `score=${String(x.score).padEnd(6)} claimed=${x.claimed.seeders}s/${x.claimed.leechers}l ` +
        `observed=${x.observed.peers}p dht=${x.observed.dhtCount} source=${x.source}`)
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
  const r = await call('/v1/assess', { method: 'POST', body: { input: ih, deadlineMs: 28000 }, timeoutMs: 90000, label: `verify ${label} against a real peer` })
  const x = r.json?.candidates?.[0]

  record(`${label} returns a verdict`, r.status === 200 && !!x?.verdict, x ? `${x.verdict} in ${r.ms}ms` : `HTTP ${r.status}`)
  if (!x) continue
  proven.push(x)

  observe(`${label} measurement`,
    `verdict=${x.verdict} peers=${x.observed.peers} verifyMs=${x.verifyMs} timedOut=${x.verifyTimedOut} source=${x.source}`)

  // Verification must never be answered from shared health. The control plane
  // deliberately stores no peer lists, so a shared answer arrives with peers: []
  // and the verdict collapses to `claimed` — a real swarm reported unprovable.
  record(`${label} probed, not shared`, x.source === 'probed', `source=${x.source}`)

  // meta is the torrent itself, pulled from a peer and checked against the
  // infohash. It is the one field that cannot be a different file.
  if (x.verdict === 'verified') {
    record(`${label} carries proven metadata`, !!x.meta?.name && x.meta.size > 0,
      `${x.meta?.name} · ${x.meta?.size} bytes · ${x.meta?.files} files`)
  } else {
    // Not a failure of the service. A swarm can be genuinely unprovable right
    // now, and saying so is the honest answer.
    observe(`${label} not verified this run`, `${x.verdict} — read with verifyTimedOut before concluding anything`)
  }
}

/* ------------------------------------------------------------------ *
 * 5. Verdict contract
 * ------------------------------------------------------------------ */

heading('5. Verdict contract')

{
  const VERDICTS = ['verified', 'reachable', 'claimed', 'none']
  record('verdicts are from the known set', proven.every(x => VERDICTS.includes(x.verdict)), proven.map(x => x.verdict).join(', '))
  record('verified implies verified:true', proven.every(x => (x.verdict === 'verified') === (x.verified === true)))

  // claimed and observed are different instruments and must stay separable:
  // conflating them is how a hash that does not exist gets a green badge.
  record('claims and proof stay separate fields',
    proven.every(x => x.claimed && x.observed && typeof x.claimed.seeders === 'number' && typeof x.observed.peers === 'number'))

  await pace()
  const r = await call('/v1/assess', { method: 'POST', body: { presets: true, deadlineMs: 28000 }, timeoutMs: 120000, label: 'tier ordering across all four fixtures' })
  if (r.status === 200) {
    const tier = { verified: 0, reachable: 1, claimed: 2, none: 3 }
    const seqTier = r.json.candidates.map(x => tier[x.verdict])
    // Nothing unproven may outrank something proven, whatever its score.
    record('sorted by verdict tier, then score', seqTier.every((v, i, a) => i === 0 || a[i - 1] <= v),
      r.json.candidates.map(x => `${x.verdict}:${x.score}`).join(' > '))
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
  const r = await call('/v1/probe', { method: 'POST', body: { input: 'not-a-magnet-or-infohash' }, label: 'unusable input' })
  record('rejects unusable input', r.status === 400 && !!r.json?.error, r.json?.error)
}

{
  await pace()
  // Valid JSON, but a string rather than a shape carrying candidates.
  const r = await call('/v1/probe', { method: 'POST', body: '"x"', timeoutMs: 20000, label: 'valid JSON, no candidates' })
  record('rejects a body with no candidates', r.status === 400, `HTTP ${r.status} ${r.json?.error || ''}`)
}

if (HOSTED) {
  {
    await pace()
    const r = await call('/v1/probe', { method: 'POST', body: { input: Array(25).fill(BBB).join('\n') }, label: '25 candidates — over the cap of 20' })
    record('caps candidates per request', r.status === 400 && /Too many candidates/.test(r.json?.error || ''), r.json?.error)
  }
  {
    await pace()
    const r = await call('/v1/assess', { method: 'POST', body: { input: SINTEL, maxPeers: 500 }, label: 'maxPeers 500 — over the cap of 60' })
    record('caps maxPeers', r.status === 400 && /maxPeers/.test(r.json?.error || ''), r.json?.error)
  }
  {
    await pace()
    const r = await call('/v1/assess', { method: 'POST', body: { input: SINTEL, deadlineMs: 900000 }, label: 'deadlineMs 900s — over the cap of 30s' })
    record('caps deadlineMs', r.status === 400 && /deadlineMs/.test(r.json?.error || ''), r.json?.error)
  }
  {
    const r = await call('/v1/stream', { label: 'streaming is not relayed through the edge' })
    record('/v1/stream is 501, not proxied', r.status === 501, r.json?.error)
  }
  {
    await pace()
    const r = await call('/v1/play', { method: 'POST', body: { presets: true }, label: 'playback is not relayed either' })
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
  await pace()
  const first = await call('/v1/probe', { method: 'POST', body: { input: COSMOS }, label: 'first ask — expect MISS' })
  const second = await call('/v1/probe', { method: 'POST', body: { input: COSMOS }, label: 'identical body — expect HIT' })

  record('identical query is cached', second.headers.get('x-cache') === 'HIT',
    `${first.headers.get('x-cache')} ${first.ms}ms → ${second.headers.get('x-cache')} ${second.ms}ms ` +
    `(${first.ms > second.ms ? `${first.ms - second.ms}ms saved` : 'no saving'})`)

  // Must be a body this run has not sent, and no earlier stage has either —
  // the key is a hash of the body, so reusing a fixture would legitimately HIT
  // and the check would be testing the test. A per-run nonexistent hash is
  // unique by construction and costs no real swarm traffic.
  await pace()
  const unique = Date.now().toString(16).padStart(40, '0').slice(-40)
  const other = await call('/v1/probe', { method: 'POST', body: { input: unique }, label: 'never-sent body — expect MISS' })
  record('an unseen query is not', other.headers.get('x-cache') === 'MISS', `x-cache=${other.headers.get('x-cache')}`)
}

/* ------------------------------------------------------------------ *
 * 8. Rate limit — opt-in, because passing it costs the whole minute
 * ------------------------------------------------------------------ */

if (HOSTED && flag('rate-limit')) {
  heading('8. Rate limit')

  let sawLimit = false
  let sent = 0
  // Vary the body so the edge cache cannot answer these without consulting the
  // limiter, and use nonexistent-but-valid hashes so no real swarm is hit.
  for (let i = 0; i < 80 && !sawLimit; i++) {
    const r = await call('/v1/probe', {
      method: 'POST',
      body: { input: i.toString(16).padStart(40, '0') },
      timeoutMs: 30000,
      label: `budget probe ${i + 1}`
    })
    sent++
    if (r.status === 429) {
      sawLimit = true
      record('429 after the budget', true, `after ${sent} requests · Retry-After=${r.headers.get('retry-after')}`)
    }
  }
  if (!sawLimit) record('429 after the budget', false, `no 429 in ${sent} requests`)
  observe('budget spent for this minute', 'later stages may 429')
} else if (HOSTED) {
  console.log(c.dim('\n8. Rate limit — skipped. Pass --rate-limit to exercise it.'))
}

/* ------------------------------------------------------------------ *
 * 9. The rest of the deployment
 * ------------------------------------------------------------------ */

if (HOSTED) {
  heading('9. Supporting services')

  {
    const r = await request(`${DOCS}/openapi.json`, { timeoutMs: 20000, label: 'published OpenAPI spec' })
    const spec = r.json
    record('docs serve the spec', r.status === 200 && spec?.openapi === '3.1.0', spec?.info?.title)
    record('spec points at this API', spec?.servers?.[0]?.url === API, spec?.servers?.[0]?.url)

    // Every route the spec advertises should exist on the deployment it names.
    const advertised = Object.keys(spec?.paths || {})
    record('spec advertises the routes tested here',
      ['/v1/assess', '/v1/probe', '/v1/status', '/healthz'].every(p => advertised.includes(p)),
      advertised.join(' '))
  }

  {
    const r = await request(`${CONTROL}/v1/status`, { timeoutMs: 20000, label: 'shared health and node pool' })
    const st = r.json
    record('control plane answers', r.status === 200 && st !== null,
      st ? `health=${st.healthEntries} contributions=${st.liveContributions} pool=${st.pool?.nodes}` : '')

    // Contributions climbing while the pool stays 0 means the merge is broken,
    // not that clients are quiet. That exact combination hid a bug where the
    // aggregator listed every contribution key and never read one.
    if (st?.liveContributions > 0 && st?.pool?.nodes === 0) {
      record('pool is built from contributions', false,
        `${st.liveContributions} contributions merged into 0 nodes — aggregator is not reading them`)
    } else if (st) {
      record('pool is built from contributions', true,
        `${st.pool.nodes} nodes, ${st.pool.corroborated} corroborated by ≥2 sources`)
    }

    // Empty health is not broken: entries carry a 900s TTL, so an idle
    // deployment legitimately reports zero.
    if (st && st.healthEntries === 0) observe('no health entries', 'expected if nothing has ranked in ~15 minutes')
  }
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const failed = results.filter(r => !r.ok)

heading('Summary')

console.log(c.bold('\n  Latency by request'))
console.log(c.dim('  ' + '#'.padEnd(5) + 'method'.padEnd(8) + 'path'.padEnd(22) + 'status'.padEnd(8) + 'ms'))
for (const t of timings) {
  console.log('  ' + String(t.n).padEnd(5) + t.method.padEnd(8) + t.path.padEnd(22) + paintStatus(t.status).padEnd(COLOR ? 17 : 8) + String(t.ms).padStart(6))
}

const sorted = timings.map(t => t.ms).sort((a, b) => a - b)
const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
const total = timings.reduce((a, t) => a + t.ms, 0)
console.log(c.dim(`\n  ${timings.length} requests · total ${total}ms · min ${sorted[0]}ms · median ${pct(0.5)}ms · p90 ${pct(0.9)}ms · max ${sorted[sorted.length - 1]}ms`))

console.log(c.bold(`\n  ${results.length - failed.length}/${results.length} checks passed against ${API}`))

if (failed.length) {
  console.log(c.red('\n  Failed:'))
  for (const f of failed) console.log(`    ${f.stage} → ${f.name}`)
}

const verified = proven.filter(x => x.verdict === 'verified').length
console.log(`\n  ${verified}/${proven.length} fixtures proved alive by pulling the torrent from a peer.`)
if (verified < proven.length) {
  console.log(c.dim('  A fixture that did not verify is not necessarily a failure — read verdict and'))
  console.log(c.dim('  verifyTimedOut together before concluding anything about the swarm.'))
}
console.log(c.dim(`  finished ${new Date().toISOString()}\n`))

process.exit(failed.length)
