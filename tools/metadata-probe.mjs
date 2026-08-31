import './env.js'
import WebTorrent from 'webtorrent'
import SwarmScout from './swarmScout.js'

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const scout = await SwarmScout.create()
await scout.ready()

function probe (label, client, arg, ms) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let t = null, done = false
    const fin = v => { if (!done) { done = true; clearTimeout(timer); try { t?.destroy(() => {}) } catch {} 
      console.log('  ' + label.padEnd(38) + (v ? 'OK "' + v + '"' : 'timeout') + '  ' + (Date.now()-t0) + 'ms'); resolve(v) } }
    const timer = setTimeout(() => fin(null), ms)
    try { t = client.add(arg) } catch (e) { return fin(null) }
    t.once('metadata', () => fin(t.name))
    t.once('error', () => fin(null))
  })
}

// A: fresh client, its own cold DHT
const a = new WebTorrent(); a.on('error', () => {})
await probe('own cold DHT, 60s', a, HASH, 60000)
await new Promise(r => a.destroy(r))

// B: client reusing the warm DHT the scout already bootstrapped
const b = new WebTorrent({ dht: scout.dht }); b.on('error', () => {})
await probe('reusing scout DHT, 60s', b, HASH, 60000)
await new Promise(r => b.destroy(r))

scout.destroy(); process.exit(0)
