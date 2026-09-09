// 滑动窗口熔断器（Redis 实现，多实例共享状态）
// 目的：通道挂掉时「直接跳过」，而不是每个请求都干等超时

import type { Redis } from 'ioredis'

export interface CircuitOptions {
  windowMs: number // 滑动窗口时长，默认 300s
  minSamples: number // 窗口内最小样本数，默认 20
  failThreshold: number // 失败率阈值，默认 0.5
  openSeconds: number // 熔断时长，默认 60s
}

export const DEFAULT_CIRCUIT: CircuitOptions = {
  windowMs: 300_000,
  minSamples: 20,
  failThreshold: 0.5,
  openSeconds: 60,
}

export class CircuitBreaker {
  private opts: CircuitOptions

  constructor(
    private redis: Redis,
    opts: Partial<CircuitOptions> = {},
  ) {
    this.opts = { ...DEFAULT_CIRCUIT, ...opts }
  }

  private kReq = (id: bigint | number) => `ai:cb:req:${id}`
  private kFail = (id: bigint | number) => `ai:cb:fail:${id}`
  private kOpen = (id: bigint | number) => `ai:cb:open:${id}`

  async isOpen(providerId: bigint | number): Promise<boolean> {
    try {
      return (await this.redis.get(this.kOpen(providerId))) !== null
    } catch {
      return false // Redis 异常时不拦截，避免误伤
    }
  }

  async open(providerId: bigint | number): Promise<void> {
    try {
      await this.redis.set(this.kOpen(providerId), '1', 'EX', this.opts.openSeconds)
    } catch {
      /* ignore */
    }
  }

  async reset(providerId: bigint | number): Promise<void> {
    try {
      await this.redis.del(this.kOpen(providerId), this.kReq(providerId), this.kFail(providerId))
    } catch {
      /* ignore */
    }
  }

  /** 记录一次调用结果，达到阈值则自动熔断 */
  async record(providerId: bigint | number, success: boolean): Promise<void> {
    const now = Date.now()
    const from = now - this.opts.windowMs
    const ttl = Math.ceil(this.opts.windowMs / 1000) + 60
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`

    try {
      const pipe = this.redis.multi()
      pipe.zadd(this.kReq(providerId), now, member)
      pipe.zremrangebyscore(this.kReq(providerId), 0, from)
      pipe.zcard(this.kReq(providerId))
      pipe.expire(this.kReq(providerId), ttl)

      if (!success) {
        pipe.zadd(this.kFail(providerId), now, member)
        pipe.zremrangebyscore(this.kFail(providerId), 0, from)
        pipe.zcard(this.kFail(providerId))
        pipe.expire(this.kFail(providerId), ttl)
      }
      const res = await pipe.exec()

      if (!res) return
      const reqCount = Number(res[2]?.[1] ?? 0)
      const failCount = success ? 0 : Number(res[6]?.[1] ?? 0)

      if (reqCount >= this.opts.minSamples && failCount / reqCount > this.opts.failThreshold) {
        await this.open(providerId)
      }
    } catch {
      /* Redis 异常：不熔断，仅降级为无状态 */
    }
  }
}
