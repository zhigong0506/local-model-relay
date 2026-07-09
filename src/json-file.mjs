import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return structuredClone(fallback)
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

export function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tempPath, 'w')

  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    closeSync(fd)
  }

  renameSync(tempPath, filePath)
}

export function backupCorruptFile(filePath, reason) {
  if (!existsSync(filePath)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.bak.${stamp}`
  renameSync(filePath, backupPath)
  console.warn(`[store] moved invalid file to ${backupPath}: ${reason}`)
  return backupPath
}
