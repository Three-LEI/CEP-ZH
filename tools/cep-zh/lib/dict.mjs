// Load translation dictionaries (global + per-extension).
// Search order: bundled dict first, then %APPDATA%\CEP-ZH\dict (user overrides).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DICT_DIR = path.join(TOOL_DIR, 'dict');
export const EXT_DICT_DIR = path.join(DICT_DIR, 'extensions');

/** All dictionary roots, lowest precedence first. */
export function dictionaryRoots() {
  const roots = [DICT_DIR];
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, 'CEP-ZH', 'dict'));
  return roots;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fs.existsSync(file)) console.warn('[dict] cannot read', file, '-', err.message);
    return null;
  }
}

export function loadDictionaries() {
  const strings = {};
  const patterns = [];
  const byKey = new Map();
  const usedFiles = [];

  for (const root of dictionaryRoots()) {
    const global = readJson(path.join(root, 'global.json'));
    if (global) {
      for (const [key, value] of Object.entries(global.strings || {})) {
        if (value) strings[key] = value;
        else if (!(key in strings)) strings[key] = '';
      }
      if (Array.isArray(global.patterns)) patterns.push(...global.patterns);
    }
    const extDir = path.join(root, 'extensions');
    let files = [];
    try {
      files = fs.readdirSync(extDir).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch { /* no extensions dir */ }
    for (const file of files) {
      const data = readJson(path.join(extDir, file));
      if (!data) continue;
      const key = file.replace(/\.json$/i, '');
      let record = byKey.get(key);
      if (!record) {
        record = { name: data.name || key, strings: {}, patterns: [], files: [] };
        byKey.set(key, record);
        byKey.set(key.toLowerCase(), record);
      }
      if (data.cleared) {
        record.strings = {};
        record.cleared = true;
      }
      for (const [key, value] of Object.entries(data.strings || {})) {
        if (value) record.strings[key] = value;
        else if (!(key in record.strings)) record.strings[key] = '';
      }
      if (Array.isArray(data.patterns)) record.patterns.push(...data.patterns);
      record.name = data.name || record.name;
      record.files.push(path.join(extDir, file));
      usedFiles.push(path.join(extDir, file));
    }
  }

  return {
    global: { strings, patterns },
    byKey,
    files: usedFiles,
  };
}

export function dictionaryKeysFor({ bundle, extId }) {
  const keys = [];
  if (bundle?.bundleId) keys.push(bundle.bundleId, bundle.bundleId.toLowerCase());
  if (extId) keys.push(extId, extId.toLowerCase());
  if (bundle?.bundleId) {
    const safe = bundle.bundleId.replace(/[^\w.-]+/g, '_');
    keys.push(safe, safe.toLowerCase());
  }
  if (extId) {
    const safe = extId.replace(/[^\w.-]+/g, '_');
    keys.push(safe, safe.toLowerCase());
  }
  return [...new Set(keys)];
}

export function buildConfigFor(dicts, { bundle, extId, port }) {
  const merged = {};
  for (const [key, value] of Object.entries(dicts.global.strings || {})) if (value) merged[key] = value;
  const patterns = [...(dicts.global.patterns || [])];
  const used = [];
  const usedFiles = [];
  for (const key of dictionaryKeysFor({ bundle, extId })) {
    const data = dicts.byKey.get(key);
    if (!data || used.includes(data)) continue;
    used.push(data);
    usedFiles.push(...(data.files || []));
    for (const [source, value] of Object.entries(data.strings || {})) {
      // Empty plugin entries must not hide a valid common-dictionary fallback.
      if (value) merged[source] = value;
    }
    if (Array.isArray(data.patterns)) patterns.push(...data.patterns);
  }
  return {
    version: '1.0.0',
    extId: extId || '',
    bundleId: bundle?.bundleId || '',
    port,
    dict: merged,
    patterns,
    dictionaryFiles: usedFiles,
  };
}
