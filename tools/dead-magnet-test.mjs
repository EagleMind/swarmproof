'use strict'

/**
 * The failure path, which is the half that actually decides whether this is
 * usable. A magnet nobody can serve must fail *fast and cleanly* — the worst
 * outcome is not "no result", it is a hang, an unhandled rejection, or a
 * process that never exits.
 *
 * The subject is an all-zero infohash with 13 trackers attached, most of them
 * long dead (coppersurfer.tk, glotorrents.pw, public.popcorn-tracker.org and
 * torrent.gresille.org have all been gone for years). So it exercises two
 * different failures at once: a swarm that does not exist, and trackers that
 * do not answer.
 *
 * Run: node tools/dead-magnet-test.mjs
 */

import '../env.js'
import SwarmScout from '../swarmScout.js'
import StreamServer from '../streamServer.js'
import { fetchFromAny } from '../metainfo.js'

const MAGNET = 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=Torrent%20does%20not%20exsist.&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Ftracker.bittor.pw%3A1337%2Fannounce&tr=udp%3A%2F%2Fpublic.popcorn-tracker.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce&tr=udp%3A%2F%2Fglotorrents.pw%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftorrent.gresille.org%3A80%2Fannounce&tr=udp%3A%2F%2Fp4p.arenabg.com%3A1337&tr=udp%3A%2F%2Ftracker.internetwarriors.net%3A1337'

/** Pull infohash, display name and trackers straight out of the magnet. */
function parseMagnet (uri) {
  const q = new URLSearchParams(uri.slice(uri.indexOf('?') + 1))
  const xt = q.get('xt') || ''
  return {
    infoHash: xt.replace(/^urn:btih:/i, '').toLowerCase(),
    label: q.get('dn') || null,
    trackers: q.getAll('tr'),
    magnetURI: uri
  }
}

const results = []
function check (name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

/** Resolve to a sentinel rather than hanging, so a hang is a result. */
function withDeadline (promise, ms, label) {
  let timer
  return Promise.race([
    promise.then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e })),
    new Promise(res => { timer = setTimeout(() => res({ timedOut: true, label }), ms) })
  ]).finally(() => clearTimeout(timer))
}

async function main () {
  const c = parseMagnet(MAGNET)
  console.log(`\nsubject: ${c.infoHash}`)
  console.log(`name:    ${c.label}`)
  console.log(`trackers: ${c.trackers.length}`)

  // Unhandled rejections are the specific failure this path is prone to:
  // a dead tracker or a socket error surfacing with no listener attached.
  const unhandled = []
  process.on('unhandledRejection', e => unhandled.push(String(e?.message || e)))
  process.on('uncaughtException', e => unhandled.push(String(e?.message || e)))

  check('magnet parsed', /^[0-9a-f]{40}$/.test(c.infoHash), `infoHash=${c.infoHash}`)

  const scout = await SwarmScout.create()

  // ---- Ranking a swarm that does not exist --------------------------
  console.log('\n[1] Ranking')
  const t0 = Date.now()
  const ranked = await scout.rank([c])
  const rankMs = Date.now() - t0
  const r = ranked[0]
  console.log(`        ${JSON.stringify(r.sources)}`)

  check('rank() returned instead of throwing', !!r, `score=${r.score} peers=${r.peers?.length || 0} in ${rankMs}ms`)
  check('no peers invented', (r.peers?.length || 0) === 0, `${r.peers?.length || 0} peers`)

  // rank() cannot separate this from a healthy swarm, and that is permanent.
  //
  // The all-zero infohash is the junk drawer of the BitTorrent network.
  // Broken clients announce to it constantly, so trackers hold real announce
  // counts for it and the DHT holds real addresses - measured at 40 claimed
  // seeders and 559 observed peers in one call, more peers than any genuine
  // film alongside it. A tracker scrape and a DHT lookup are the only signals
  // rank() has, and both of them say healthy. No weighting of those two
  // numbers can fix that, because the numbers are not wrong: people really
  // are announcing to this hash. There is simply nothing behind it.
  //
  // So this is recorded rather than asserted. The resolution is one layer up.
  console.log(`  note  rank() scores this ${r.score} on ${r.sources.seeders} claimed ` +
    `seeders / ${r.sources.dhtCount} DHT peers - indistinguishable from real, by design`)

  // assess() CAN separate it, and must. This is the regression test for the
  // scoring defect: ask a real sample of peers, and when none of them has the
  // torrent, that is evidence against the tracker's number rather than an
  // absence of evidence for it.
  console.log('\n[1b] Refutation')
  const [assessed] = await scout.assess([c], { deadlineMs: 25_000, maxPeers: 40 })

  check('assess() refutes a hash nobody can serve',
    assessed.refuted === true,
    `refuted=${assessed.refuted} verdict=${assessed.verdict} peers=${assessed.peers?.length || 0} ` +
    `timedOut=${assessed.verifyTimedOut}`)

  check('refutation damps the score',
    assessed.refuted ? assessed.score < assessed.rawScore : false,
    `${assessed.rawScore} -> ${assessed.score}`)

  check('the damped score is auditable',
    typeof assessed.rawScore === 'number' && assessed.rawScore >= assessed.score,
    `rawScore=${assessed.rawScore} kept alongside score=${assessed.score}`)

  // The point of the 13-tracker list: 8 or so are dead hostnames. If the
  // scrape were serial, or waited on every tracker, this would be the
  // slowest path in the engine rather than the fastest.
  check('dead trackers do not extend the budget', rankMs < scout.probeBudgetMs + 1500,
    `${rankMs}ms against a ${scout.probeBudgetMs}ms budget`)

  // ---- Metadata with nothing to ask ---------------------------------
  console.log('\n[2] Metadata')
  const t1 = Date.now()
  const meta = await fetchFromAny(c.infoHash, r.peers || [], { maxPeers: 40 })
  check('metadata returns null, not a hang', meta === null, `null in ${Date.now() - t1}ms`)

  // ---- Playback must refuse, not stall ------------------------------
  // A caller that gets a promise which never settles has no way to fail
  // over, so "refuses in bounded time" is the contract that matters.
  console.log('\n[3] Playback')
  const server = new StreamServer()
  await server.listen()
  const t2 = Date.now()
  const outcome = await withDeadline(server.play(ranked), 90_000, 'play')
  const playMs = Date.now() - t2

  if (outcome.timedOut) {
    check('play() settles in bounded time', false, `still pending after ${playMs}ms`)
  } else if (outcome.ok) {
    // Not a pass: there is nothing on the network to have played.
    check('play() rejects a swarm that does not exist', false,
      `resolved after ${playMs}ms with file=${server.file?.name || 'none'}`)
  } else {
    check('play() rejects a swarm that does not exist', true,
      `"${outcome.error?.message}" after ${playMs}ms`)
  }

  await server.destroy()
  scout.destroy()

  // Give anything in flight a moment to surface before judging.
  await new Promise(res => setTimeout(res, 1500))
  check('no unhandled rejections or crashes', unhandled.length === 0,
    unhandled.length ? unhandled.slice(0, 3).join(' | ') : 'clean')

  const failed = results.filter(x => !x.pass)
  console.log(`\n${'='.repeat(64)}`)
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  failed.forEach(f => console.log(`  FAILED: ${f.name} - ${f.detail}`))
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
