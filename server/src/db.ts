// 单例：Prisma Client + Redis
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
})

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
})

export { prisma, redis }
