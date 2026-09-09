// AI 网关单例：创作/分镜生成路由复用，避免每个请求重建熔断器计数
import { prisma, redis } from '../db.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { AiGateway } from './gateway.js'

export const aiGateway = new AiGateway(prisma, redis, new CircuitBreaker(redis))
