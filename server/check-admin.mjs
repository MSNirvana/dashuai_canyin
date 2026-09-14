import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const users = await prisma.adminUser.findMany({ select: { id: true, username: true, status: true, displayName: true } });
console.log(JSON.stringify(users, (k,v) => typeof v === 'bigint' ? String(v) : v, 2));
await prisma.$disconnect();
