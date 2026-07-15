import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rootDir } from '../src/paths.mjs'

const source = await readFile(resolve(rootDir, 'src', 'upstream-fetch.mjs'), 'utf8')
const requiredSnippets = [
  'secureSocket.once(\'secureConnect\', () => finish(null, secureSocket))',
  'secureSocket.once(\'error\', (error) => finish(error))',
  'request.once(\'close\', () => agent.destroy())',
  'protectSocketErrors(socket)',
]
const missing = requiredSnippets.filter((snippet) => !source.includes(snippet))
if (missing.length) {
  throw new Error(`Upstream socket error guard is missing: ${missing.join(', ')}`)
}
console.log(JSON.stringify({
  ok: true,
  lateTlsErrorsHandled: true,
  connectSocketErrorsHandled: true,
}, null, 2))
