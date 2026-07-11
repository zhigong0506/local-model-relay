import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { rootDir } from '../src/paths.mjs'

const requestedScript = process.argv[2]
if (!requestedScript) {
  console.error('Usage: node scripts/run-isolated-e2e.mjs scripts/<test>.mjs')
  process.exit(2)
}

const scriptPath = resolve(rootDir, requestedScript)
const scriptsDir = resolve(rootDir, 'scripts')
if (!scriptPath.startsWith(`${scriptsDir}${sep}`) || !scriptPath.endsWith('.mjs')) {
  console.error('The isolated runner only accepts .mjs files inside scripts/.')
  process.exit(2)
}

const tempRoot = await mkdtemp(resolve(tmpdir(), 'local-model-relay-e2e-'))
const dataDir = resolve(tempRoot, 'data')
const port = await reservePort()
const relayUrl = `http://127.0.0.1:${port}`
let serverProcess = null

try {
  serverProcess = spawn(process.execPath, [resolve(rootDir, 'src', 'server.mjs')], {
    cwd: rootDir,
    env: {
      ...process.env,
      LOCAL_MODEL_RELAY_DATA_DIR: dataDir,
      LOCAL_MODEL_RELAY_HOST: '127.0.0.1',
      LOCAL_MODEL_RELAY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const serverOutput = captureOutput(serverProcess)
  await waitForHealth(relayUrl, serverProcess, serverOutput)

  const result = await runChild(process.execPath, [scriptPath], {
    ...process.env,
    RELAY_URL: relayUrl,
  })
  if (result !== 0 && (serverOutput.stderr || serverOutput.stdout)) {
    console.error('\nIsolated relay output:\n' + (serverOutput.stderr || serverOutput.stdout))
  }
  process.exitCode = result
} finally {
  await stopServer(serverProcess, relayUrl)
  await removeVerifiedTempDirectory(tempRoot)
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function captureOutput(child) {
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  return output
}

async function waitForHealth(relayUrl, child, output) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated relay exited early (${child.exitCode}).\n${output.stderr || output.stdout}`)
    }
    try {
      const response = await fetch(`${relayUrl}/health`)
      if (response.ok && (await response.json()).ok) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for isolated relay.\n${output.stderr || output.stdout}`)
}

function runChild(command, args, env) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) return reject(new Error(`${basename(args[0])} exited by signal ${signal}`))
      resolveExit(code ?? 1)
    })
  })
}

async function stopServer(child, relayUrl) {
  if (!child || child.exitCode !== null) return
  try {
    await fetch(`${relayUrl}/api/process/exit`, { method: 'POST' })
  } catch {}
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2000)),
  ])
  if (child.exitCode === null) child.kill()
}

async function removeVerifiedTempDirectory(path) {
  const resolved = resolve(path)
  const tempBase = `${resolve(tmpdir())}${sep}`
  if (!resolved.startsWith(tempBase) || !basename(resolved).startsWith('local-model-relay-e2e-')) {
    throw new Error(`Refusing to remove unexpected test directory: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
