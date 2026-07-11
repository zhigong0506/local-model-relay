import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeOutboundPlan, maskProxyUrl, resolveOutboundProxyPlan } from '../src/outbound-proxy.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const configPath = resolve(rootDir, 'data', 'config.json')
const service = loadServiceConfig()
const plan = resolveOutboundProxyPlan(service)
const args = [...plan.nodeArgs, resolve(rootDir, 'src', 'server.mjs')]

relayLog(`launcher outbound: ${describeOutboundPlan(plan)}`)
if (plan.warning) relayWarn(`launcher warning: ${plan.warning}`)
if (plan.detectedProxyUrl && plan.proxySource !== 'custom') {
  relayLog(`launcher detected proxy: ${maskProxyUrl(plan.detectedProxyUrl)}`)
}

const child = spawn(process.execPath, args, {
  cwd: rootDir,
  env: plan.env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  relayLog(signal ? `server exited by signal ${signal}` : `server exited with code ${code ?? 0}`)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  relayError(`launcher failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

function loadServiceConfig() {
  if (!existsSync(configPath)) return {}

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    return config && typeof config.service === 'object' && !Array.isArray(config.service)
      ? config.service
      : {}
  } catch (error) {
    relayWarn(`launcher warning: failed to read config, using direct outbound. ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function relayLog(message) {
  console.log(`[${new Date().toISOString()}] [relay] ${message}`)
}

function relayWarn(message) {
  console.warn(`[${new Date().toISOString()}] [relay] ${message}`)
}

function relayError(message) {
  console.error(`[${new Date().toISOString()}] [relay] ${message}`)
}
