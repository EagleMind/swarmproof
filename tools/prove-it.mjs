#!/usr/bin/env node
//
// The ten-second demonstration.
//
// Takes an infohash that has never existed and one that has, asks the public
// trackers what they think of each, then asks a peer. The trackers cannot
// tell them apart. Asking a peer settles it immediately.
//
//   npm run prove-it
//   npm run prove-it -- <infohash-or-magnet> [...]
//
// Runs against the hosted API so it needs nothing installed and no engine
// running. Point it elsewhere with --api http://127.0.0.1:8080.

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const API = opt('api', 'https://swarmproof-api.hassen-ben-mbarek.workers.dev').replace(/\/+$/, '')

const subjects = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--api')

/**
 * The default pair, chosen because one of them cannot possibly work.
 *
 * The all-zero infohash is the junk drawer of the BitTorrent DHT: broken
 * clients announce to it constantly, so trackers hold genuine announce counts
 * for content that has never existed. Sintel is a Blender Foundation open
 * movie under CC-BY that is reliably seeded.
 */
const DEFAULT = [
  { label: 'A hash that has never existed', hash: '0000000000000000000000000000000000000000' },
  { label: 'Sintel (2010, CC-BY)', hash: '08ada5a7a6183aae1e09d831df6748d566095a10' }
]

const C = process.stdout.isTTY !== false && !args.includes('--no-color')
const dim = s => C ? `\x1b[90m${s}\x1b[0m` : s
const bold = s => C ? `\x1b[1m${s}\x1b[0m` : s
const green = s => C ? `\x1b[32m${s}\x1b[0m` : s
const red = s => C ? `\x1b[31m${s}\x1b[0m` : s

const targets = subjects.length
  ? subjects.map(h => ({ label: h.slice(0, 48), hash: h }))
  : DEFAULT

console.log(bold('\n  Seeder counts cannot tell these apart. Asking a peer can.\n'))
console.log(dim(`  via ${API}\n`))

const rows = []

for (const t of targets) {
  process.stdout.write(dim(`  asking about ${t.label} … `))

  const res = await fetch(`${API}/v1/assess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: t.hash, deadlineMs: 28000 }),
    signal: AbortSignal.timeout(90000)
  })

  if (!res.ok) {
    console.log(red(`HTTP ${res.status}`))
    continue
  }
  const c = (await res.json()).candidates[0]
  console.log(dim('done'))
  rows.push({ ...t, c })
}

console.log('')
console.log('  ' + bold('WHAT THE TRACKERS CLAIM') + dim('  — a number nothing verifies'))
console.log('')
for (const { label, c } of rows) {
  console.log(`    ${label.padEnd(34)} ${String(c.claimed.seeders).padStart(5)} seeders  ${String(c.claimed.leechers).padStart(5)} leechers  ${String(c.observed.peers).padStart(5)} peers seen`)
}

console.log('')
console.log('  ' + bold('WHAT A PEER ACTUALLY SERVED') + dim('  — SHA1(info) checked against the hash'))
console.log('')
for (const { label, c } of rows) {
  const proven = c.verdict === 'verified'
  const mark = proven ? green('  PROVEN  ') : red(' UNPROVEN ')
  const detail = proven
    ? `${c.meta.name} · ${(c.meta.size / 1e6).toFixed(0)} MB · ${c.meta.files} files`
    : c.refuted
      ? `refuted — ${c.observed.peers} peers asked, none had it`
      : `${c.verdict} — nothing served it`
  console.log(`    ${label.padEnd(34)} ${mark}  ${detail}`)
}

const junk = rows.find(r => !['verified'].includes(r.c.verdict))
if (junk && rows.some(r => r.c.verdict === 'verified')) {
  console.log('')
  console.log(dim('  Note the peer counts above. The unprovable hash often has *more* peers'))
  console.log(dim('  than the real one — people announce to it constantly. Peer counts do not'))
  console.log(dim('  separate them either. Only asking a peer for the torrent does.'))
  if (junk.c.refuted) {
    console.log(dim(`  Its score is damped from ${junk.c.rawScore} to ${junk.c.score} once refuted.`))
  }
}
console.log('')
