'use strict'

/**
 * Candidate construction: turning what a person types into something the
 * discovery layer can probe.
 *
 * A "candidate" is the unit SwarmScout ranks — an infohash, a label to
 * print, and the trackers worth asking about it. Nothing here knows what
 * the content *is*; that question belongs to a catalogue, and this project
 * deliberately no longer has one.
 *
 * index.js keeps its own copy on purpose — it is the documented
 * end-to-end example and should stay readable standalone.
 */

/**
 * Trackers measured as live from this machine. Deliberately omitted:
 *   tracker.openbittorrent.com:6969 - never answered, burned the full 8s
 *   tracker.gbitt.info              - HTTPS scrape failed immediately
 */
export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce'
]

export function makeCandidate (label, infoHash, trackers = TRACKERS) {
  return {
    label,
    infoHash: infoHash.toLowerCase(),
    magnetURI: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(label)}` +
      trackers.map(t => `&tr=${encodeURIComponent(t)}`).join(''),
    trackers
  }
}

/**
 * Known-good test swarms.
 *
 * These are fixtures, not a catalogue — four Blender Foundation open movies
 * (CC-BY) that are freely redistributable and reliably seeded, so there is
 * always something real to point a probe at. Their value here is that the
 * right answer is known in advance: Big Buck Bunny should outrank Cosmos
 * Laundromat on seeders every time, so a ranking that disagrees is a bug in
 * the scorer rather than a quiet swarm.
 */
export const PRESETS = [
  { id: 'sintel', label: 'Sintel', year: 2010, infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10' },
  { id: 'bbb', label: 'Big Buck Bunny', year: 2008, infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c' },
  { id: 'cosmos', label: 'Cosmos Laundromat', year: 2015, infoHash: 'c9e15763f722f23e98a29decdfae341b98d53056' },
  { id: 'tos', label: 'Tears of Steel', year: 2012, infoHash: '209c8226b299b308beaf2b9cd3fb49212dbd13ec' }
]

const BTIH = /\bxt=urn:btih:([a-z0-9]{40}|[a-z2-7]{32})\b/i

/**
 * Accept either a full magnet URI or a bare 40-char infohash.
 * Trackers embedded in the magnet are kept and merged with the known-live
 * list, since a user-supplied magnet usually carries the trackers that
 * actually have the swarm.
 */
export function parseInput (raw) {
  const input = String(raw || '').trim()
  if (!input) throw new Error('Empty input')

  if (/^[a-f0-9]{40}$/i.test(input)) return makeCandidate(input.slice(0, 8), input)

  if (!input.toLowerCase().startsWith('magnet:')) {
    throw new Error('Not a magnet link or a 40-character infohash')
  }

  const match = BTIH.exec(input)
  if (!match) throw new Error('Magnet link has no xt=urn:btih: infohash')

  const url = new URL(input)
  const label = url.searchParams.get('dn') || match[1].slice(0, 8)
  const embedded = url.searchParams.getAll('tr')
  const merged = [...new Set([...embedded, ...TRACKERS])]

  return { label, infoHash: match[1].toLowerCase(), magnetURI: input, trackers: merged }
}
