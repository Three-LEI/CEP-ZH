// Shared translation API helpers for the agent and CLI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_DATA = process.env.APPDATA || '';

export function loadTranslationConfig() {
  const file = path.join(APP_DATA, 'CEP-ZH', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  cfg.targetLang = cfg.targetLang || 'zh-CN';
  return cfg;
}

/** True only for strings that actually contain translatable Latin text. */
export function isTranslatable(s) {
  if (typeof s !== 'string') return false;
  const k = s.replace(/\s+/g, ' ').trim();
  if (!k || k.length > 240) return false;
  // Pure Chinese, pure numbers, pure symbols and punctuation are skipped.
  if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(k)) return false;
  if (/[{}]/.test(k)) return false;
  if (/(?:fill|stroke|font-size|font-family|background|opacity|color|margin|padding|display)\s*:/i.test(k)) return false;
  if (/^(?:https?|file):\/\//i.test(k)) return false;
  if (/^[\d\s.,+\-:/%()]+$/.test(k)) return false;
  return true;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('translation response is not JSON');
}

async function fetchJson(url, options = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 240));
    try { return JSON.parse(text); } catch { throw new Error('response is not JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function freeTarget(lang, { edge = false } = {}) {
  const value = String(lang || 'zh-CN');
  if (!edge) return value;
  return value === 'zh-CN' ? 'zh-Hans' : value === 'zh-TW' ? 'zh-Hant' : value;
}

async function translateGoogle(cfg, strings) {
  const target = freeTarget(cfg.targetLang);
  const base = (cfg.freeBaseUrl || 'https://translate.googleapis.com').replace(/\/+$/, '');
  const out = {};
  await mapLimit(strings, 3, async (s) => {
    const qs = new URLSearchParams({ client: 'gtx', dt: 't', sl: 'auto', tl: target, q: s });
    const data = await fetchJson(base + '/translate_a/single?' + qs.toString());
    const parts = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
    const text = parts.map((p) => (Array.isArray(p) ? p[0] : '')).join('');
    if (text) out[s] = text;
  });
  return out;
}

async function translateEdge(cfg, strings) {
  const target = freeTarget(cfg.targetLang, { edge: true });
  const url = 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=' + encodeURIComponent(target);
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    },
    body: JSON.stringify(strings),
  }, 30000);
  const out = {};
  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      const text = item && Array.isArray(item.translations) && item.translations[0] && item.translations[0].text;
      if (text && strings[i]) out[strings[i]] = text;
    });
  }
  return out;
}

async function translateYandex(cfg, strings) {
  const target = String(cfg.targetLang || 'zh-CN').split('-')[0] || 'zh';
  const out = {};
  await mapLimit(strings, 2, async (s) => {
    const body = new URLSearchParams({
      srv: 'android',
      ucid: crypto.randomBytes(16).toString('hex'),
      lang: target,
      text: s,
    });
    const data = await fetchJson('https://translate.yandex.net/api/v1/tr.json/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (Number(data.code) !== 200) throw new Error('Yandex code ' + data.code + ' ' + (data.message || ''));
    const text = Array.isArray(data.text) ? data.text.join('') : '';
    if (text) out[s] = text;
  });
  return out;
}

async function translateOpenAI(cfg, strings) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const system = 'You are a professional software UI localizer. Translate the given English UI strings to ' +
    (cfg.targetLang || 'zh-CN') +
    '. Keep placeholders, shortcuts, product names, and technical identifiers unchanged. ' +
    'Return ONLY a JSON object of the form {"translations":{"original":"translation"}}.';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.apiKey || '') },
      body: JSON.stringify({
        model: cfg.model || (/deepseek/i.test(cfg.baseUrl || '') ? 'deepseek-flash' : 'gpt-4o-mini'),
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify({ strings }) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('OpenAI HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    const parsed = parseJson(text);
    return parsed.translations || parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function translateDeepL(cfg, strings) {
  const base = (cfg.baseUrl || 'https://api-free.deepl.com').replace(/\/+$/, '');
  const body = new URLSearchParams();
  body.set('auth_key', cfg.apiKey || '');
  body.set('target_lang', (cfg.targetLang || 'zh-CN').split('-')[0].toUpperCase());
  for (const s of strings) body.append('text', s);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(base + '/v2/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('DeepL HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const out = {};
    (data.translations || []).forEach((t, i) => { out[strings[i]] = t.text; });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function translateStrings(cfg, strings, { onProgress } = {}) {
  const list = [...new Set(strings.filter(isTranslatable))];
  if (!list.length) return {};
  const provider = String(cfg.provider || '').toLowerCase();
  if (!provider || provider === 'none') throw new Error('翻译 API 未配置（provider=none）');

  const out = {};
  const size = provider === 'deepl' ? 45 : 40;
  let done = 0;
  for (const batch of chunk(list, size)) {
    let part;
    if (provider === 'mock') {
      part = {};
      for (const s of batch) part[s] = '【译】' + s;
    } else if (provider === 'openai') {
      part = await translateOpenAI(cfg, batch);
    } else if (provider === 'deepl') {
      part = await translateDeepL(cfg, batch);
    } else if (provider === 'google') {
      part = await translateGoogle(cfg, batch);
    } else if (provider === 'edge') {
      part = await translateEdge(cfg, batch);
    } else if (provider === 'yandex') {
      part = await translateYandex(cfg, batch);
    } else {
      throw new Error('未知的翻译 provider: ' + provider);
    }
    for (const s of batch) {
      if (part && typeof part[s] === 'string' && part[s]) out[s] = part[s];
    }
    done += batch.length;
    if (onProgress) onProgress(done, list.length);
  }
  return out;
}
