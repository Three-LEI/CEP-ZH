#!/usr/bin/env node
/**
 * cep-zh translate: turn a catalog into a dictionary using a translation API.
 *
 * Config (%APPDATA%\CEP-ZH\config.json):
 *   {
 *     "provider": "openai" | "deepl" | "mock",
 *     "baseUrl": "https://api.deepseek.com",
 *     "model": "deepseek-flash",
 *     "apiKey": "sk-...",
 *     "targetLang": "zh-CN"
 *   }
 *
 * Usage:
 *   node translate.mjs --catalog catalog/com.rendertom.flow.json --bundle com.rendertom.flow
 *   node translate.mjs --catalog ... --out dict/extensions/com.rendertom.flow.auto.json --write
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(TOOL_DIR, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'translate.json');

const { values: args } = parseArgs({
  options: {
    catalog: { type: 'string' },
    bundle: { type: 'string' },
    out: { type: 'string' },
    provider: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string' },
    'target-lang': { type: 'string' },
    limit: { type: 'string', default: '80' },
    write: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    config: { type: 'string' },
    'dict-dir': { type: 'string' },
  },
});

function dictDir() {
  if (args['dict-dir']) return args['dict-dir'];
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'CEP-ZH', 'dict') : path.join(TOOL_DIR, 'dict');
}

function defaultConfigPath() {
  const appData = process.env.APPDATA;
  if (appData) {
    const p = path.join(appData, 'CEP-ZH', 'config.json');
    if (fs.existsSync(p)) return p;
  }
  return path.join(TOOL_DIR, 'config.example.json');
}

function loadConfig() {
  const file = args.config || defaultConfigPath();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (args.provider) cfg.provider = args.provider;
  if (args['base-url']) cfg.baseUrl = args['base-url'];
  if (args.model) cfg.model = args.model;
  if (args['api-key']) cfg.apiKey = args['api-key'];
  if (args['target-lang']) cfg.targetLang = args['target-lang'];
  cfg.targetLang = cfg.targetLang || 'zh-CN';
  return { cfg, file };
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}
const hash = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

function collectStrings(catalog) {
  const set = new Set();
  for (const s of Object.keys(catalog.strings || {})) if (s.trim()) set.add(s);
  for (const s of Object.keys(catalog.attrs || {})) if (s.trim()) set.add(s);
  return [...set].filter((s) => /[A-Za-z\u00C0-\u024F]/.test(s) && !/[\u4e00-\u9fff]/.test(s));
}

function sameText(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

function openAiSystem(cfg, retry) {
  let system = 'You are a professional software UI localizer. Translate every given UI string to ' +
    (cfg.targetLang || 'zh-CN') + '. ' +
    'Translate short labels and mixed labels as well; for example, "X LocalStore" should become "X 本地存储". ' +
    'Keep placeholders, shortcuts, URLs, file paths and code identifiers unchanged, but do not return an entire string unchanged unless it is only a product name or a code symbol. ' +
    'Return ONLY a JSON object of the form {"translations":{"original":"translation"}}.';
  if (retry) system += ' The previous response copied these strings unchanged. Translate them now; do not echo the source.';
  return system;
}

async function requestOpenAI(cfg, strings, retry) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.apiKey || '') },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: openAiSystem(cfg, retry) },
        { role: 'user', content: JSON.stringify({ strings }) },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error('OpenAI HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(text);
  return parsed.translations || parsed;
}

async function translateOpenAI(cfg, strings) {
  const out = await requestOpenAI(cfg, strings, false);
  const copied = strings.filter((s) => out[s] && sameText(out[s], s));
  if (!copied.length) return out;
  try {
    const retry = await requestOpenAI(cfg, copied, true);
    for (const s of copied) {
      if (retry[s] && !sameText(retry[s], s)) out[s] = retry[s];
    }
  } catch {}
  return out;
}

async function translateDeepL(cfg, strings) {
  const base = (cfg.baseUrl || 'https://api-free.deepl.com').replace(/\/+$/, '');
  const body = new URLSearchParams();
  body.set('auth_key', cfg.apiKey || '');
  body.set('target_lang', (cfg.targetLang || 'zh-CN').split('-')[0].toUpperCase());
  for (const s of strings) body.append('text', s);
  const res = await fetch(base + '/v2/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('DeepL HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const out = {};
  (data.translations || []).forEach((t, i) => { out[strings[i]] = t.text; });
  return out;
}

function translateMock(strings) {
  const out = {};
  for (const s of strings) out[s] = '【译】' + s;
  return out;
}

async function main() {
  if (!args.catalog) {
    console.error('usage: node translate.mjs --catalog catalog/foo.json [--bundle foo] [--write]');
    process.exit(2);
  }
  const { cfg, file } = loadConfig();
  const catalog = JSON.parse(fs.readFileSync(args.catalog, 'utf8'));
  const bundle = args.bundle || catalog.bundleId || path.basename(args.catalog, '.json');
  const limit = Number(args.limit) || 80;
  const strings = collectStrings(catalog).slice(0, limit);
  if (!strings.length) {
    console.log('no translatable strings');
    return;
  }
  console.log(`provider=${cfg.provider || 'none'} bundle=${bundle} strings=${strings.length} config=${file}`);
  if (args['dry-run']) {
    for (const s of strings) console.log('  ' + s);
    return;
  }
  if (!cfg.provider || cfg.provider === 'none') {
    throw new Error('no provider in config; use --provider openai|deepl|mock');
  }

  const cache = loadCache();
  const keyBase = (cfg.provider || '') + '|' + (cfg.targetLang || '') + '|';
  const todo = strings.filter((s) => !cache[keyBase + s]);
  console.log(`cache hit ${strings.length - todo.length}, request ${todo.length}`);
  let fresh = {};
  let unchanged = 0;
  if (todo.length) {
    if (cfg.provider === 'openai') fresh = await translateOpenAI(cfg, todo);
    else if (cfg.provider === 'deepl') fresh = await translateDeepL(cfg, todo);
    else if (cfg.provider === 'mock') fresh = translateMock(todo);
    else throw new Error('unknown provider: ' + cfg.provider);
    for (const [s, t] of Object.entries(fresh)) {
      if (sameText(t, s)) { unchanged++; continue; }
      cache[keyBase + s] = t;
    }
    saveCache(cache);
  }

  const dict = {
    name: bundle,
    strings: {},
    patterns: [],
  };
  for (const s of strings) {
    const t = cache[keyBase + s];
    if (t && !sameText(t, s)) dict.strings[s] = t;
    else if (t) unchanged++;
  }
  if (unchanged) console.log(`unchanged ${unchanged} (not written)`);
  const out = args.out || path.join(dictDir(), 'extensions', bundle + '.auto.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(dict, null, 2), 'utf8');
  console.log(`wrote ${out} (${Object.keys(dict.strings).length} entries)`);
  if (args.write) {
    const finalPath = path.join(dictDir(), 'extensions', bundle + '.json');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(finalPath, 'utf8')); } catch {}
    existing.name = existing.name || bundle;
    existing.strings = { ...(existing.strings || {}), ...dict.strings };
    existing.patterns = existing.patterns || [];
    fs.writeFileSync(finalPath, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`merged into ${finalPath}; agent will hot-reload`);
  }
}

main().catch((err) => {
  console.error('translate failed:', err.message);
  process.exit(1);
});
