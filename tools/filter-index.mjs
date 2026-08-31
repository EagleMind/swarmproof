'use strict'

/**
 * Apply the content filter to names already in the index.
 *
 * Everything crawled before contentFilter.js existed went in unchecked. This
 * runs the same rules over those rows and blocks the matches.
 *
 * **This pass is weaker than the live one, and the difference matters.** The
 * live filter matches over the torrent name *and every file path*, because a
 * torrent whose name looks innocuous routinely carries the real content in
 * its file names. Stored rows kept only a file *count*, so this can check
 * names alone. Rows it clears are "the name does not match", never "this
 * torrent is fine".
 *
 * The honest fix for that is to re-fetch metadata for old rows so their paths
 * can be checked too. Until then, treat a pre-filter index as partially
 * cleaned rather than clean.
 *
 *   node tools/filter-index.mjs --dry-run     report what would be blocked
 *   node tools/filter-index.mjs               apply it
 */

import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import ContentFilter from '../contentFilter.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const db = new DatabaseSync(path.join(process.cwd(), '.dht-index.db'))
db.exec('PRAGMA busy_timeout = 5000')
try { db.exec('ALTER TABLE torrents ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0') } catch { /* already there */ }

const filter = new ContentFilter()
console.log(`\nrules: ${filter.keywordCount} keywords\n`)

const rows = db.prepare(
  'SELECT info_hash, name, size FROM torrents WHERE resolved = 1 AND blocked = 0 AND name IS NOT NULL'
).all()

console.log(`checking ${rows.length.toLocaleString()} named rows...`)

const block = db.prepare(
  'UPDATE torrents SET blocked = 1, resolved = 1, name = NULL WHERE info_hash = ?')

const reasons = new Map()
let matched = 0

for (const row of rows) {
  // No `paths` available for stored rows — see the note at the top.
  const verdict = filter.check({ name: row.name, size: Number(row.size) || 0 })
  if (!verdict.blocked) continue
  matched++
  reasons.set(verdict.reason, (reasons.get(verdict.reason) || 0) + 1)
  if (!dryRun) block.run(row.info_hash)
}

console.log(`\n${dryRun ? 'would block' : 'blocked'}: ${matched.toLocaleString()} of ${rows.length.toLocaleString()}`)
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  // Counts by reason only. The matching titles are deliberately not printed —
  // echoing them would just move the problem into the terminal and the logs.
  console.log(`   ${String(n).padStart(6)}  ${reason}`)
}

if (dryRun) {
  console.log('\n(dry run — nothing written)')
} else {
  const after = db.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN resolved = 1 AND blocked = 0 THEN 1 ELSE 0 END) AS named, SUM(blocked) AS blocked FROM torrents'
  ).get()
  console.log(`\nindex now: ${(after.total || 0).toLocaleString()} hashes, ` +
    `${(after.named || 0).toLocaleString()} searchable names, ` +
    `${(after.blocked || 0).toLocaleString()} blocked`)
}

console.log('\nNote: names only. Stored rows carry no file paths, so this is a\n' +
  'weaker check than the live filter. Treat a pre-filter index as partially\n' +
  'cleaned, not clean.\n')

db.close()
