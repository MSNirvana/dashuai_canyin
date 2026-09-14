import jwt from 'jsonwebtoken';

const SECRET = 'local-development-secret';
const token = jwt.sign(
  { aid: '1', username: 'admin', typ: 'admin' },
  SECRET,
  { expiresIn: '2h', issuer: 'dshuaai-server', audience: 'dshuaai-client', algorithm: 'HS256' }
);

const BASE = 'http://127.0.0.1:3000/admin/api/v1';
const paths = ['/ai/scenes', '/ai/models', '/ai/providers', '/ai/call-logs?page=1&pageSize=3'];

for (const p of paths) {
  try {
    const res = await fetch(BASE + p, { headers: { authorization: 'Bearer ' + token } });
    const json = await res.json();
    const data = json.data;
    let summary = '';
    if (Array.isArray(data)) summary = `数组长度 ${data.length}`;
    else if (data && Array.isArray(data.list)) summary = `list 长度 ${data.list.length}, total=${data.total}`;
    else summary = JSON.stringify(data).slice(0, 120);
    console.log(`[${res.status}] ${p}  code=${json.code}  => ${summary}`);
    if (res.status !== 200) console.log('    message:', json.message);
  } catch (e) {
    console.log(`[ERR] ${p}  => ${e.message}`);
  }
}
