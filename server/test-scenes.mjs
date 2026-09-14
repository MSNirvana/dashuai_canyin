import jwt from 'jsonwebtoken';
const token = jwt.sign({ aid: '1', username: 'admin', typ: 'admin' }, 'local-development-secret',
  { expiresIn: '2h', issuer: 'dshuaai-server', audience: 'dshuaai-client', algorithm: 'HS256' });
const res = await fetch('http://127.0.0.1:3000/admin/api/v1/ai/scenes', { headers: { authorization: 'Bearer ' + token } });
const json = await res.json();
console.log('HTTP', res.status, 'code', json.code, '共', (json.data || []).length, '个场景');
for (const s of json.data) {
  const fb = (s.fallbackModels || []).map((m) => m.modelCode).join(',') || '-';
  const def = s.defaultModel ? s.defaultModel.modelCode : s.defaultModelId;
  console.log('  ' + s.code.padEnd(22) + ' default=' + def.padEnd(12) + ' fallback=' + fb.padEnd(12) + ' 温度=' + (s.temperature ?? '-') + ' 上限=' + (s.maxOutputTokens ?? '-') + ' 冻结=' + s.beanPrice + '豆');
}
