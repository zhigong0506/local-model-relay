import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const publicDir = resolve(rootDir, 'public')
export const dataDir = process.env.LOCAL_MODEL_RELAY_DATA_DIR
  ? resolve(process.env.LOCAL_MODEL_RELAY_DATA_DIR)
  : resolve(rootDir, 'data')
export const configPath = resolve(dataDir, 'config.json')
export const statePath = resolve(dataDir, 'state.json')
