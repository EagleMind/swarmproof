import dgram from 'dgram'
import dns from 'dns/promises'
const id = Buffer.alloc(20, 0x41)
const ping = Buffer.concat([Buffer.from('d1:ad2:id20:'), id, Buffer.from('e1:q4:ping1:t2:aa1:y1:qe')])
const NAMES = ['router.silotis.us','dht.aelitis.com','dht.bitcomet.com','router.bitcomet.com','dht.libtorrent.org','dht.transmissionbt.com']
for (const n of NAMES) {
  let a4 = 'FAIL', a6 = 'FAIL'
  try { a4 = (await dns.resolve4(n)).join(',') } catch {}
  try { a6 = (await dns.resolve6(n)).join(',') } catch {}
  console.log(`[dns] ${n.padEnd(24)} A=${a4.padEnd(28)} AAAA=${a6}`)
}
console.log()
const T = [['router.silotis.us',6881],['dht.aelitis.com',6881],['dht.bitcomet.com',6881],['dht.libtorrent.org',25401],['dht.transmissionbt.com',6881]]
for (const [host, port] of T) {
  let hits = 0, best = null
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now()
    const ok = await new Promise(resolve => {
      const s = dgram.createSocket('udp4'); let g = false
      const fin = v => { if (!g) { g = true; try { s.close() } catch {}; resolve(v) } }
      s.on('message', () => fin(1)); s.on('error', () => fin(0))
      s.send(ping, port, host, e => e && fin(0))
      setTimeout(() => fin(0), 8000)
    })
    if (ok) { hits++; best = Math.min(best ?? 1e9, Date.now() - t0) }
  }
  console.log(`${hits ? 'ALIVE' : 'dead '} ${hits}/4  ${host}:${port}${best !== null ? `  (best ${best}ms)` : ''}`)
}
process.exit(0)
