// 手动应用 persona 门店化 migration（该库无 prisma migration 基线，沿用直接执行 SQL 的惯例）
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const sql = readFileSync(new URL('../prisma/migrations/20260911150000_persona_store_level/migration.sql', import.meta.url), 'utf8')
// 按分号拆分（本文件无存储过程/触发器，安全）
const statements = sql
  .split(';')
  .map((s) => s.replace(/--.*$/gm, '').trim())
  .filter((s) => s.length > 0)

for (const stmt of statements) {
  try {
    await prisma.$executeRawUnsafe(stmt)
    console.log('OK :', stmt.replace(/\s+/g, ' ').slice(0, 80))
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('Duplicate') || msg.includes('already exists')) {
      console.log('SKIP:', msg.slice(0, 60))
    } else {
      console.error('FAIL:', stmt.replace(/\s+/g, ' ').slice(0, 80), '\n  →', msg)
      process.exit(1)
    }
  }
}
await prisma.$disconnect()
console.log('\nmigration 应用完成')
