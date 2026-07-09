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

console.log(`[relay] launcher outbound: ${describeOutboundPlan(plan)}`)
if (plan.warning) console.warn(`[relay] launcher warning: ${plan.warning}`)
if (plan.detectedProxyUrl && plan.proxySource !== 'custom') {
  console.log(`[relay] launcher detected proxy: ${maskProxyUrl(plan.detectedProxyUrl)}`)
}

const child = spawn(process.execPath, args, {
  cwd: rootDir,
  env: plan.env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(`[relay] launcher failed: ${error instanceof Error ? error.message : String(error)}`)
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
    console.warn(`[relay] launcher warning: failed to read config, using direct outbound. ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}
