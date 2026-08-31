'use strict'

import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Cache of swarm health and DHT routing nodes, keyed by infoHash.
 * Stores: { peers: [{host, port}], score, ts }
 *
 * SQLite rather than a JSON file, because the JSON version was not safe to
 * share. It held the whole cache in memory and did a `writeFileSync` of the
 * entire structure on every `set()`, which has two failure modes the moment
 * a second process exists:
 *
 *   lost writes  each process persists its own in-memory copy, so whoever
 *                writes last silently discards everything the other learned
 *   corruption   writeFileSync is not atomic; a reader can observe a
 *                half-written file, and JSON.parse then throws away the
 *                entire cache
 *
 * Neither shows up with one process, which is why the original was fine for
 * an MVP and its own comment flagged this as the upgrade path.
 *
 * WAL mode gives concurrent readers alongside a writer, `busy_timeout` makes
 * contention wait instead of failing, and each `set()` is a single atomic
 * UPSERT rather than a rewrite of the world.
 *
 * Uses the `node:sqlite` module built into Node 22 — still no dependency.
 */
export default class PeerCache {
  constructor ({
    file = path.join(process.cwd(), '.peer-cache.db'),
    ttlMs = 10 * 60 * 1000,
    migrateFrom = path.join(process.cwd(), '.peer-cache.json')
  } = {}) {
    this.file = file
    this.ttlMs = ttlMs
    this.closed = false

    this.db = new DatabaseSync(file)

    // Write-ahead logging: readers no longer block on the writer, which is
    // the whole point of moving off a single rewritten file.
    this.db.exec('PRAGMA journal_mode = WAL')
    // Contention should wait, not throw SQLITE_BUSY at a caller who only
    // wanted a cache hit.
    this.db.exec('PRAGMA busy_timeout = 5000')
    // The cache is disposable by definition; durability is not worth an
    // fsync on the hot path.
    this.db.exec('PRAGMA synchronous = NORMAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarms (
        info_hash TEXT PRIMARY KEY,
        peers     TEXT    NOT NULL,
        score     REAL    NOT NULL,
        ts        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        host TEXT    NOT NULL,
        port INTEGER NOT NULL,
        seen INTEGER NOT NULL,
        PRIMARY KEY (host, port)
      );
    `)

    this._get = this.db.prepare('SELECT peers, score, ts FROM swarms WHERE info_hash = ?')
    this._set = this.db.prepare(`
      INSERT INTO swarms (info_hash, peers, score, ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(info_hash) DO UPDATE SET peers = excluded.peers,
                                           score = excluded.score,
                                           ts    = excluded.ts`)
    this._del = this.db.prepare('DELETE FROM swarms WHERE info_hash = ?')
    this._selectNodes = this.db.prepare('SELECT host, port FROM nodes ORDER BY seen DESC LIMIT ?')
    this._upsertNode = this.db.prepare(`
      INSERT INTO nodes (host, port, seen) VALUES (?, ?, ?)
      ON CONFLICT(host, port) DO UPDATE SET seen = excluded.seen`)
    this._trimNodes = this.db.prepare(`
      DELETE FROM nodes WHERE rowid NOT IN (
        SELECT rowid FROM nodes ORDER BY seen DESC LIMIT ?)`)

    this._migrate(migrateFrom)
  }

  /** Carry a pre-existing JSON cache over once, so upgrading does not throw
   *  away a warm routing table and start cold. */
  _migrate (jsonFile) {
    if (!jsonFile || !fs.existsSync(jsonFile)) return
    const already = this.db.prepare('SELECT COUNT(*) AS n FROM swarms').get()
    if (already.n > 0) return

    try {
      const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
      const swarms = raw.swarms || raw || {}
      let moved = 0
      for (const [infoHash, entry] of Object.entries(swarms)) {
        if (!entry || typeof entry.ts !== 'number') continue
        this._set.run(infoHash, JSON.stringify(entry.peers || []), entry.score || 0, entry.ts)
        moved++
      }
      if (Array.isArray(raw.nodes) && raw.nodes.length) this.setNodes(raw.nodes)
      if (moved || raw.nodes?.length) {
        console.log(`[peerCache] migrated ${moved} swarms + ${raw.nodes?.length || 0} nodes from ${path.basename(jsonFile)}`)
      }
    } catch (err) {
      console.warn('[peerCache] could not migrate old JSON cache:', err.message)
    }
  }

  get (infoHash) {
    if (this.closed) return null
    let row
    try {
      row = this._get.get(infoHash)
    } catch (err) {
      // A cache is a speed optimisation, never a correctness requirement.
      console.warn('[peerCache] read failed:', err.message)
      return null
    }
    if (!row) return null

    if (Date.now() - row.ts > this.ttlMs) {
      try { this._del.run(infoHash) } catch { /* eviction is best-effort */ }
      return null
    }

    let peers = []
    try { peers = JSON.parse(row.peers) } catch { /* treat as no peers */ }
    return { peers, score: row.score, ts: row.ts }
  }

  set (infoHash, { peers, score }) {
    if (this.closed) return
    try {
      this._set.run(infoHash, JSON.stringify(peers || []), score || 0, Date.now())
    } catch (err) {
      console.warn('[peerCache] write failed:', err.message)
    }
  }

  isFresh (infoHash) {
    return this.get(infoHash) !== null
  }

  /** Known-good DHT routing nodes from previous sessions ({host, port}). */
  getNodes (max = 300) {
    if (this.closed) return []
    try {
      return this._selectNodes.all(max).map(r => ({ host: r.host, port: r.port }))
    } catch (err) {
      console.warn('[peerCache] node read failed:', err.message)
      return []
    }
  }

  /**
   * Persist the routing table. Capped because re-pinging a huge list on
   * startup costs more than it saves; the closest few hundred is plenty
   * to re-enter the network.
   *
   * Written as one transaction so a concurrent reader never sees a
   * partially-replaced table.
   */
  setNodes (nodes, max = 300) {
    if (this.closed) return
    if (!Array.isArray(nodes) || nodes.length === 0) return

    const seen = new Set()
    const now = Date.now()
    try {
      this.db.exec('BEGIN IMMEDIATE')
      for (const n of nodes) {
        if (!n || !n.host || !n.port) continue
        const key = `${n.host}:${n.port}`
        if (seen.has(key)) continue
        seen.add(key)
        this._upsertNode.run(String(n.host), Number(n.port), now)
        if (seen.size >= max) break
      }
      this._trimNodes.run(max)
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      console.warn('[peerCache] node write failed:', err.message)
    }
  }

  /**
   * Close the database, and make every later access a no-op.
   *
   * The flag is the point, not the close. Discovery work is deliberately
   * fire-and-forget — `_backgroundRefresh` keeps probing after a shared-health
   * answer has already been returned — so a shutdown can land in the middle of
   * it, and the callback then writes through statements the close has
   * finalized. That surfaced as 42 `statement has been finalized` warnings in
   * one benchmark run: harmless in effect, but it is a use-after-free being
   * reported as a log line, and it would fire on any shutdown during a refresh.
   *
   * Swallowing the write is right rather than merely convenient: the cache is
   * disposable by definition, and a process on its way out has nothing to gain
   * from persisting one more entry.
   */
  close () {
    this.closed = true
    try { this.db.close() } catch { /* already closed */ }
  }
}
