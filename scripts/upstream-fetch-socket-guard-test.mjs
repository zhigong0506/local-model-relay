import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rootDir } from '../src/paths.mjs'

const source = await readFile(resolve(rootDir, 'src', 'upstream-fetch.mjs'), 'utf8')
const requiredSnippets = [
  'secureSocket.on(\'error\', rejectOnce)',
  'secureSocket.once(\'close\'',
  'protectSocketErrors(socket)',
]
const missing = requiredSnippets.filter((snippet) => !source.includes(snippet))
if (missing.length) {
  throw new Error(`Upstream socket error guard is missing: ${missing.join(', ')}`)
}
if (source.includes("secureSocket.off('error', reject)")) {
  throw new Error('TLS socket error listener is still removed immediately after response.')
}

console.log(JSON.stringify({
  ok: true,
  lateTlsErrorsHandled: true,
  connectSocketErrorsHandled: true,
}, null, 2))
