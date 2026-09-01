#!/usr/bin/env node
//
// The demonstration, self-contained.
//
// Takes an infohash that has never existed and one that has, asks the public
// trackers what they think of each, then asks a peer. The trackers cannot
// tell them apart. Asking a peer settles it immediately.
//
//   npm run prove-it
//   npm run prove-it -- <infohash-or-magnet> [...]
//
// No server, no hosted endpoint, no configuration. It builds an engine in
// process, talks to the live BitTorrent network from this machine, and tears
// it down. Everything it prints was measured during the run.
//
// Expect ~15-30s: a cold DHT has to bootstrap, and verification opens real
// TCP connections to strangers.

import '../env.js'
import SwarmScout from '../swarmScout.js'
import { parseInput } from '../catalog.js'

const args = process.argv.slice(2)
const subjects = args.filter(a => !a.startsWith('--'))

/**
 * The default pair, chosen because one of them cannot possibly work.
 *
 * The all-zero infohash is the junk drawer of the BitTorrent DHT: broken
 * clients announce to it constantly, so trackers hold genuine announce counts
 * and the DHT holds genuine addresses — for content that has never existed.
 * Sintel is a Blender Foundation open movie under CC-BY, reliably seeded.
 */
const DEFAULT = [
  ['A hash that has never existed', '0000000000000000000000000000000000000000'],
  ['Sintel (2010, CC-BY)', '08ada5a7a6183aae1e09d831df6748d566095a10']
]

const C = process.stdout.isTTY !== false && !args.includes('--no-color')
const dim = s => C ? `\x1b[90m${s}\x1b[0m` : s
const bold = s => C ? `\x1b[1m${s}\x1b[0m` : s
const green = s => C ? `\x1b[32m${s}\x1b[0m` : s
const red = s => C ? `\x1b[31m${s}\x1b[0m` : s

const targets = subjects.length
  ? subjects.map(h => [h.length > 48 ? h.slice(0, 45) + '…' : h, h])
  : DEFAULT

console.log(bold('\n  Seeder counts cannot tell these apart. Asking a peer can.\n'))
console.log(dim('  Building an engine and probing the live network — this takes a moment.\n'))

const scout = await SwarmScout.create()

const candidates = targets.map(([label, hash]) => ({ ...parseInput(hash), label }))
const started = Date.now()
const results = await scout.assess(candidates, { deadlineMs: 28_000, maxPeers: 40 })
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

// assess() returns best-first, which is not the order we listed them in.
const byHash = new Map(results.map(r => [r.infoHash, r]))
const rows = targets.map(([label, hash]) => ({
  label,
  r: byHash.get(parseInput(hash).infoHash)
})).filter(x => x.r)

console.log('  ' + bold('WHAT THE TRACKERS CLAIM') + dim('  — a number nothing verifies'))
console.log('')
for (const { label, r } of rows) {
  console.log(`    ${label.padEnd(34)} ${String(r.sources.seeders).padStart(5)} seeders  ` +
    `${String(r.sources.leechers).padStart(5)} leechers  ${String(r.peers?.length || 0).padStart(5)} peers seen`)
}

console.log('')
console.log('  ' + bold('WHAT A PEER ACTUALLY SERVED') + dim('  — SHA1(info) checked against the hash'))
console.log('')
for (const { label, r } of rows) {
  const proven = r.verdict === 'verified'
  const mark = proven ? green('  PROVEN  ') : red(' UNPROVEN ')
  const detail = proven
    ? `${r.meta.name} · ${(r.meta.size / 1e6).toFixed(0)} MB · ${r.meta.files} files`
    : r.refuted
      ? `refuted — ${r.peers?.length || 0} peers asked, none had it`
      : `${r.verdict} — nothing served it`
  console.log(`    ${label.padEnd(34)} ${mark}  ${detail}`)
}

const junk = rows.find(x => x.r.verdict !== 'verified')
if (junk && rows.some(x => x.r.verdict === 'verified')) {
  console.log('')
  console.log(dim('  Note the peer counts. The unprovable hash often has *more* peers than the'))
  console.log(dim('  real one — people announce to it constantly — so peer counts do not separate'))
  console.log(dim('  them either. Only asking a peer for the torrent does.'))
  if (junk.r.refuted) {
    console.log(dim(`  Its score is damped from ${junk.r.rawScore} to ${junk.r.score} once refuted.`))
  }
}

console.log(dim(`\n  ${elapsed}s against the live network.\n`))

scout.destroy()
