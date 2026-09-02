import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
const tail = Number(process.argv[3] ?? 40)
const raw = readFileSync(path)
// the file is a sequence of zstd frames; decompress as one stream
const text = zstdDecompressSync(raw).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim().length > 0)
for (const line of lines.slice(-tail)) {
  let ev
  try { ev = JSON.parse(line) } catch { console.log(line); continue }
  const kind = ev.type ?? ev.kind ?? '?'
  const data = ev.data ?? ev
  const s = JSON.stringify(data)
  console.log(`${kind}: ${s.length > 700 ? s.slice(0, 700) + '…' : s}`)
}
console.log(`--- total events: ${lines.length}`)
