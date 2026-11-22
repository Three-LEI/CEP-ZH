import http from 'node:http';
import { translateStrings, isTranslatable } from '../tools/cep-zh/lib/translate-api.mjs';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const input = JSON.parse(parsed.messages?.at(-1)?.content || '{"strings":[]}').strings || [];
    const translations = {};
    for (const s of input) translations[s] = '译:' + s;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
  });
});
await new Promise((r) => server.listen(18081, '127.0.0.1', r));
const out = await translateStrings({ provider: 'openai', baseUrl: 'http://127.0.0.1:18081', apiKey: 'test', targetLang: 'zh-CN' }, ['Apply', 'Cancel', '应用', '123']);
console.log(JSON.stringify(out));
server.close();
