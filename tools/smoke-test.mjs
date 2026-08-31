import SwarmScout from '../swarmScout.js'
import StreamServer from '../streamServer.js'

const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce','udp://explodie.org:6969/announce','udp://open.demonii.com:1337/announce']
const c = (label, infoHash) => ({ label, infoHash, trackers: TRACKERS,
  magnetURI: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(label)}` + TRACKERS.map(t=>`&tr=${encodeURIComponent(t)}`).join('') })

const scout = new SwarmScout()
await scout.ready()
const ranked = await scout.rank([ c('Sintel','08ada5a7a6183aae1e09d831df6748d566095a10') ])
const server = new StreamServer()
const port = await server.listen()
await server.play(ranked)
console.log(`serving "${server.file.name}" ${server.file.length} bytes on :${port}`)

const url = `http://localhost:${port}/`

async function range (label, header) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: header ? { Range: header } : {}, signal: AbortSignal.timeout(45000) })
    const reader = res.body.getReader()
    let got = 0
    // read only the first ~256KB then bail, we're testing headers + first bytes
    while (got < 256 * 1024) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
    }
    reader.cancel().catch(() => {})
    console.log(`${label.padEnd(26)} status=${res.status} CL=${res.headers.get('content-length')} CR=${res.headers.get('content-range')} AR=${res.headers.get('accept-ranges')} type=${res.headers.get('content-type')} firstBytes=${got} in ${Date.now()-t0}ms`)
  } catch (e) {
    console.log(`${label.padEnd(26)} FAILED after ${Date.now()-t0}ms: ${e.message}`)
  }
}

console.log('\n--- Range behaviour ---')
await range('no Range (full)', null)
await range('bytes=0-1048575', 'bytes=0-1048575')
const mid = Math.floor(server.file.length / 2)
await range(`seek to middle`, `bytes=${mid}-${mid + 1048575}`)
await range('open-ended tail', `bytes=${server.file.length - 500000}-`)
console.log('\n--- invalid Range (should be 416, not negative Content-Length) ---')
await range('beyond EOF', `bytes=${server.file.length + 1000}-`)
await range('inverted', 'bytes=900-100')

console.log(`\nfinal: peers=${server.torrent.numPeers} downloaded=${server.torrent.downloaded} progress=${(server.torrent.progress*100).toFixed(1)}%`)
await server.destroy()
scout.destroy()
process.exit(0)
