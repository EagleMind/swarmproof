'use strict'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * What must never enter the index.
 *
 * A BEP 51 crawler does not choose what it finds — it samples whatever the
 * network is currently storing, and the network stores everything. Running
 * one unfiltered for a few minutes was enough to resolve a title tagged for
 * child sexual abuse material. That is not an edge case to handle later; it
 * is the ordinary output of an unfiltered crawl, and it is the reason this
 * module gates persistence rather than decorating it.
 *
 * The design is ported from bitmagnet (MIT), which solves this in its
 * classifier rather than in its crawler:
 *
 *   internal/classifier/classifier.core.yml   the `banned` keyword list, and
 *                                             a workflow whose FIRST action is
 *                                             to delete anything matching it
 *   internal/keywords/parser.go               the keyword -> regex compiler
 *   internal/protocol/metainfo/banning/       three cheap junk checks
 *
 * Two properties of theirs are worth copying exactly, because both are easy
 * to get subtly wrong:
 *
 *   1. The match runs over the torrent name *and every file path*, joined.
 *      A torrent whose name looks innocuous routinely carries the real
 *      content in its file names. A name-only filter misses precisely the
 *      cases that matter most.
 *
 *   2. The action is *delete*, not flag. Nothing matching is stored, so
 *      there is no row to leak through a query that forgets a WHERE clause.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RULES = path.join(HERE, 'rules', 'banned-keywords.json')

/* ------------------------------------------------------------------ *
 * The keyword DSL
 * ------------------------------------------------------------------ */

/**
 * bitmagnet's keywords are not raw regex — they are a small language, and
 * compiling them naively (joining them with `|` as literals) would both
 * over-match and under-match. Ported from internal/keywords/parser.go:
 *
 *   *      any run of word characters      -> \w*
 *   #      a digit                         -> \d
 *   (sp)   any non-word character          -> [^0-9A-Za-z_]
 *   (x)    group; (x)? makes it optional
 *   |      alternation inside one keyword
 *   x?     zero or one of the previous token
 *   x+     one or more of the previous token
 *   \x     literal x
 *
 * Everything else is a literal character. Matching is case-insensitive:
 * upstream builds explicit [Aa] classes per letter, which for the ASCII
 * keywords involved is exactly equivalent to the `i` flag used here.
 */
export function compileKeyword (keyword) {
  const NON_WORD = '[^0-9A-Za-z_]'
  let out = ''
  let i = 0

  while (i < keyword.length) {
    const ch = keyword[i]

    if (ch === '\\') {
      // Escape: the next character is a literal, whatever it is.
      const next = keyword[++i]
      if (next === undefined) throw new Error(`trailing backslash in "${keyword}"`)
      out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
      continue
    }

    if (ch === '*') { out += '\\w*'; i++; continue }
    if (ch === '#') { out += '\\d'; i++; continue }
    if (ch === ' ') { out += NON_WORD; i++; continue }
    if (ch === '(' || ch === ')' || ch === '|' || ch === '?' || ch === '+') {
      // Structural characters pass through as regex syntax.
      out += ch
      i++
      continue
    }

    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i++
  }

  return out
}

/**
 * Wrap the alternation the way upstream does.
 *
 * The bounding groups are the important part: a keyword only matches when it
 * sits at a string edge or is surrounded by non-word characters, so "anal"
 * cannot fire inside "analysis" or "canal". Dropping the bounds would make
 * this filter useless through sheer false-positive volume.
 */
export function compileKeywords (keywords) {
  if (!keywords?.length) throw new Error('no keywords provided')
  const NON_WORD = '[^0-9A-Za-z_]'
  const alternation = [...new Set(keywords)].map(k => `(?:${compileKeyword(k)})`).join('|')
  return new RegExp(`(?:^|${NON_WORD}+)(?:${alternation})(?:$|${NON_WORD}+)`, 'i')
}

/* ------------------------------------------------------------------ *
 * Junk checks
 * ------------------------------------------------------------------ */

/**
 * Ported from bitmagnet's banning package. Nothing to do with safety — these
 * reject metadata that is malformed or too small to be a real torrent, and
 * they exist because an index full of 200-byte nameless entries is worse than
 * a smaller clean one.
 */
const MIN_NAME_LENGTH = 8
const MIN_TOTAL_SIZE = 1024

/**
 * A short name is only junk when the payload is negligible too.
 *
 * The ported rule rejected any name under 8 characters on its own, and it
 * was measured wrong twice over. It deleted Sintel — 129MB, 11 files, a
 * real torrent whose title is six letters — and the same goes for Up, Her,
 * Dune. And in a 423,015-row index the rule had left *exactly zero* rows
 * with a name shorter than 8, so nothing about its effect was visible.
 *
 * The index also shows the premise is simply false. Grouped by name length,
 * the 8-9 character bucket has the *largest* median size of any bucket
 * (2,543MB, against ~1,173MB for names over 40), and only 1.2% of it falls
 * under 10MB. Short names correlate with big torrents, not junk.
 *
 * So the two signals are judged together. At 10MB the conjunction still
 * catches the tiny-name-tiny-payload junk it was meant for, while sparing
 * the 98.8% of short-named torrents that carry real content.
 */
const MIN_SHORT_NAME_SIZE = 10 * 1024 * 1024

function junkReason (meta) {
  const name = String(meta.name || '')
  const size = Number(meta.size) || 0
  // An unnamed torrent is unusable at any size — nothing to display, and
  // nothing for the banned-keyword pass to match on.
  if (!name.trim()) return 'name empty'
  if (size < MIN_TOTAL_SIZE) return 'size too small'
  if (name.length < MIN_NAME_LENGTH && size < MIN_SHORT_NAME_SIZE) return 'name too short'
  // A null byte or lone surrogate means the peer sent something we cannot
  // store or display safely.
  const strings = [name, ...(meta.paths || [])]
  for (const s of strings) {
    // A NUL byte, or a lone surrogate left once valid pairs are removed:
    // either means the peer sent bytes we cannot store or display safely.
    // Written as an escape; a literal NUL does not survive editors or diffs.
    if (s.includes('\x00')) return 'invalid utf8 string'
    if (/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
      return 'invalid utf8 string'
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * The filter
 * ------------------------------------------------------------------ */

export class ContentFilter {
  constructor ({ rulesFile = DEFAULT_RULES, keywords = null, junk = true } = {}) {
    this.junk = junk
    this.stats = { checked: 0, banned: 0, junk: 0 }

    let list = keywords
    if (!list) {
      const raw = JSON.parse(fs.readFileSync(rulesFile, 'utf8'))
      list = raw.keywords
    }
    this.keywordCount = list.length
    this.banned = compileKeywords(list)
  }

  /**
   * @param {{name: string, size: number, paths?: string[]}} meta
   * @returns {{blocked: boolean, reason: string|null}}
   */
  check (meta) {
    this.stats.checked++

    // Name and every file path, joined — see the note at the top of this file.
    const subject = [String(meta.name || ''), ...(meta.paths || [])].join(' ')

    if (this.banned.test(subject)) {
      this.stats.banned++
      // Deliberately does not echo what matched. A log line quoting the
      // offending text just moves the problem into the log.
      return { blocked: true, reason: 'banned' }
    }

    if (this.junk) {
      const reason = junkReason(meta)
      if (reason) {
        this.stats.junk++
        return { blocked: true, reason }
      }
    }

    return { blocked: false, reason: null }
  }
}

export default ContentFilter
