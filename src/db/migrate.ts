import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(here, '../../migrations')

const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
for (const file of files) {
  const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8')
  await pool.query(sql)
  console.log(`applied ${file}`)
}
await pool.end()
