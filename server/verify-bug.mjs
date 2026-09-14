import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const scenes = await prisma.aiScene.findMany({ orderBy: { code: 'asc' } });
  console.log('aiScene 记录数:', scenes.length);
  const first = scenes[0];
  console.log('字段类型检查:');
  console.log('  id:', typeof first.id, first.id);
  console.log('  defaultModelId:', typeof first.defaultModelId, first.defaultModelId);
  console.log('  beanPrice:', typeof first.beanPrice, first.beanPrice);
  console.log('  fallbackModelIds:', typeof first.fallbackModelIds, JSON.stringify(first.fallbackModelIds));
  console.log('\n模拟 res.json() 序列化:');
  try {
    const s = JSON.stringify({ code: 0, message: 'ok', data: scenes });
    console.log('  成功, 长度:', s.length);
  } catch (e) {
    console.log('  失败 =>', e.constructor.name + ': ' + e.message);
  }
  console.log('\n同样检查 aiModel:');
  const models = await prisma.aiModel.findMany();
  try {
    JSON.stringify(models);
    console.log('  aiModel 序列化成功');
  } catch (e) {
    console.log('  aiModel 序列化失败 =>', e.message);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
