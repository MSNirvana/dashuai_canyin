import type { PrismaClient } from '@prisma/client'

export const REMINDER_DAYS = [7, 3, 1] as const
export type ReminderChannel = 'IN_APP'

function windowFor(endAt: Date, days: number) {
  const target = endAt.getTime() - days * 24 * 60 * 60 * 1000
  return { start: new Date(target - 12 * 60 * 60 * 1000), end: new Date(target + 12 * 60 * 60 * 1000) }
}

/** 创建到期提醒。只创建站内提醒，不伪造微信订阅消息已发送。唯一键保证重复扫描幂等。 */
export async function scanMembershipReminders(prisma: PrismaClient, now = new Date()) {
  const memberships = await prisma.membership.findMany({
    where: { status: 'ACTIVE', endAt: { gt: now } },
    select: { id: true, merchantId: true, endAt: true },
    take: 500,
  })
  let created = 0
  for (const membership of memberships) {
    for (const reminderDays of REMINDER_DAYS) {
      const w = windowFor(membership.endAt, reminderDays)
      if (now < w.start || now > w.end) continue
      const result = await prisma.membershipReminder.upsert({
        where: { membershipId_reminderDays_channel: { membershipId: membership.id, reminderDays, channel: 'IN_APP' } },
        create: {
          merchantId: membership.merchantId,
          membershipId: membership.id,
          reminderDays,
          channel: 'IN_APP',
          status: 'PENDING',
          scheduledAt: new Date(membership.endAt.getTime() - reminderDays * 24 * 60 * 60 * 1000),
        },
        update: {},
      })
      if (result.createdAt.getTime() >= now.getTime() - 2_000) created += 1
    }
  }
  return { scanned: memberships.length, created }
}

export async function listMyReminders(prisma: PrismaClient, merchantId: bigint, limit = 20) {
  return prisma.membershipReminder.findMany({
    where: { merchantId, status: { in: ['PENDING', 'READ'] } },
    orderBy: { scheduledAt: 'desc' },
    take: limit,
    select: { id: true, reminderDays: true, status: true, scheduledAt: true, sentAt: true, membership: true },
  })
}

export async function markReminderRead(prisma: PrismaClient, merchantId: bigint, id: bigint) {
  return prisma.membershipReminder.updateMany({
    where: { id, merchantId, status: 'PENDING' },
    data: { status: 'READ' },
  })
}

let timer: NodeJS.Timeout | undefined
export function startMembershipReminderSweeper(prisma: PrismaClient) {
  const run = () => void scanMembershipReminders(prisma).catch((e) => console.error('[membership-reminder] scan failed:', (e as Error).message))
  run()
  timer = setInterval(run, 15 * 60 * 1000)
  timer.unref()
}
export function stopMembershipReminderSweeper() {
  if (timer) clearInterval(timer)
  timer = undefined
}
