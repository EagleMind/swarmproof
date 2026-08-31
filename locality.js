'use strict'

import os from 'os'

/**
 * How much a peer is worth *given where it is*.
 *
 * The original score — `seeders * 10 + dhtPeers * 4 + leechers` — treats
 * every peer as equally reachable. On the public internet that is roughly
 * true: the variance between two random residential peers is small compared
 * to the variance in whether they answer at all.
 *
 * Inside a fleet it is badly false. Twenty seeders in another region and
 * four in the same rack are not comparable numbers, and the flat formula
 * prefers the twenty — which is the wrong answer, because rack-local
 * transfer is an order of magnitude cheaper in both latency and cross-AZ
 * egress. Weighting each peer by locality inverts that: 4 × 3.0 beats
 * 20 × 0.3.
 *
 * Two signals, in order of trust:
 *
 *   measured RTT   ground truth, available whenever the peer was reached by
 *                  a real handshake (see peerSources.js)
 *   address        a fallback when RTT is unknown: same /24 is almost
 *                  certainly the same rack or subnet, same /16 the same AZ
 *
 * A peer with neither signal scores 1.0 — exactly neutral — so a public
 * internet deployment behaves as it always did.
 */

/**
 * RTT thresholds in ms, and what a peer at that distance is worth.
 *
 * Same-region is the 1.0 baseline; everything else is relative to it. The
 * cross-region penalty is deliberately steep rather than gentle, because the
 * cost difference is steep: a first gentler cut (0.8 at 78ms) still ranked
 * 20 cross-region seeders above 4 rack-local ones, which is the exact
 * inversion this exists to fix. Cross-AZ and cross-region traffic is also
 * billed, so distance is not only slower, it is dearer.
 */
const RTT_TIERS = [
  { maxMs: 1, factor: 4.0 },    // same host or same rack
  { maxMs: 5, factor: 2.5 },    // same availability zone
  { maxMs: 25, factor: 1.0 },   // same region — the baseline
  { maxMs: 100, factor: 0.3 },  // cross-region
  { maxMs: Infinity, factor: 0.15 }
]

const SAME_24_FACTOR = 3.0
const SAME_16_FACTOR = 1.8
const LOOPBACK_FACTOR = 4.0
const NEUTRAL = 1.0

/** Local IPv4 addresses, used to judge subnet proximity. */
function localAddresses () {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

const LOCAL_V4 = localAddresses()

/**
 * Operator-declared local ranges, as `a.b.c.` / `a.b.` prefixes.
 *
 *   SWARM_SCOUT_LOCAL_CIDRS=10.4.1.,10.4.2.
 *
 * Prefix matching rather than real CIDR arithmetic: fleets are configured in
 * whole octets, and this avoids a dependency for something that is only ever
 * a scoring hint.
 */
const DECLARED = String(process.env.SWARM_SCOUT_LOCAL_CIDRS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const isV4 = host => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
const prefix = (host, octets) => host.split('.').slice(0, octets).join('.') + '.'

/**
 * @param {{host: string, port: number, rttMs?: number}} peer
 * @returns {number} multiplier; 1.0 means "no information, treat normally"
 */
export function localityFactor (peer) {
  if (!peer || !peer.host) return NEUTRAL
  const host = String(peer.host)

  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return LOOPBACK_FACTOR

  // Measured latency beats any inference from the address.
  if (typeof peer.rttMs === 'number' && Number.isFinite(peer.rttMs)) {
    return RTT_TIERS.find(t => peer.rttMs <= t.maxMs).factor
  }

  if (!isV4(host)) return NEUTRAL

  for (const p of DECLARED) {
    if (host.startsWith(p)) return SAME_24_FACTOR
  }

  for (const local of LOCAL_V4) {
    if (prefix(host, 3) === prefix(local, 3)) return SAME_24_FACTOR
    if (prefix(host, 2) === prefix(local, 2)) return SAME_16_FACTOR
  }

  return NEUTRAL
}

/**
 * Locality-weighted peer count.
 *
 * Replaces a raw count in the score, so "how many peers" becomes "how much
 * usable peer capacity is actually near me".
 */
export function weightedPeerCount (peers) {
  if (!peers?.length) return 0
  return peers.reduce((sum, p) => sum + localityFactor(p), 0)
}

/**
 * Mean locality across the peers we managed to observe.
 *
 * Tracker scrape counts are swarm-wide and carry no per-peer address, so
 * they cannot be weighted individually. The peers we did see are the only
 * evidence available about how far away this swarm sits, so their mean
 * locality scales the scrape-derived part of the score.
 *
 * Returns exactly 1.0 when nothing was observed, leaving the score untouched.
 */
export function meanLocality (peers) {
  if (!peers?.length) return NEUTRAL
  return weightedPeerCount(peers) / peers.length
}

/** True when any locality signal is configured or measurable. */
export const localityConfigured = () => DECLARED.length > 0
