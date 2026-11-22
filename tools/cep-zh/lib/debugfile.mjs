// Read / merge / write CEP ".debug" files (remote debugging port map).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseXml, elementChildren, findFirst, findAll, textOf, attr } from './xml.mjs';

const local = (name) => (name.includes(':') ? name.split(':').pop() : name);

function findFirstLocal(el, name) {
  for (const c of elementChildren(el)) {
    if (local(c.name) === name) return c;
    const nested = findFirstLocal(c, name);
    if (nested) return nested;
  }
  return null;
}

function findAllLocal(el, name, out = []) {
  for (const c of elementChildren(el)) {
    if (local(c.name) === name) out.push(c);
    findAllLocal(c, name, out);
  }
  return out;
}

export const DEBUG_FILE = '.debug';
export const BACKUP_SUFFIX = '.cep-zh.bak';

export function debugPathFor(basePath) {
  return path.join(basePath, DEBUG_FILE);
}

/** @returns {{[extId: string]: {[host: string]: number}}} */
export function readDebugFile(basePath) {
  const file = debugPathFor(basePath);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    return {};
  }
  const root = findFirstLocal(doc, 'ExtensionList');
  if (!root) return {};
  const out = {};
  for (const ext of findAllLocal(root, 'Extension')) {
    const id = attr(ext, 'Id');
    if (!id) continue;
    const hostList = findFirstLocal(ext, 'HostList');
    if (!hostList) continue;
    out[id] = out[id] || {};
    for (const h of findAllLocal(hostList, 'Host')) {
      const name = attr(h, 'Name');
      const port = Number.parseInt(attr(h, 'Port'), 10);
      if (name && Number.isInteger(port) && port > 0) out[id][name] = port;
    }
  }
  return out;
}

/**
 * Merge additions into existing debug entries without changing existing ports.
 * @param {{[extId:string]: {[host:string]: number}}} existing
 * @param {{id:string, hosts: {[host:string]: number}}[]} additions
 */
export function mergeDebugEntries(existing, additions) {
  const merged = {};
  for (const [id, hosts] of Object.entries(existing)) {
    merged[id] = { ...hosts };
  }
  let changed = false;
  for (const add of additions) {
    if (!merged[add.id]) merged[add.id] = {};
    for (const [host, port] of Object.entries(add.hosts)) {
      if (merged[add.id][host] === undefined) {
        merged[add.id][host] = port;
        changed = true;
      }
    }
  }
  return { entries: merged, changed };
}

export function serializeDebug(entries, { marker = true } = {}) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  if (marker) lines.push('<!-- generated/merged by cep-zh (Adobe CEP universal injection localizer) -->');
  lines.push('<ExtensionList>');
  for (const id of Object.keys(entries).sort()) {
    const hosts = entries[id];
    lines.push(`  <Extension Id="${escapeXml(id)}">`);
    lines.push('    <HostList>');
    for (const host of Object.keys(hosts).sort()) {
      lines.push(`      <Host Name="${escapeXml(host)}" Port="${hosts[host]}" />`);
    }
    lines.push('    </HostList>');
    lines.push('  </Extension>');
  }
  lines.push('</ExtensionList>');
  lines.push('');
  return lines.join('\n');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Write a debug file, keeping a one-time backup of the original.
 * @returns {{written:boolean, backup:string|null, created:boolean, hash:string, entries:object}}
 */
export function writeDebugFile(basePath, entries, state) {
  const file = debugPathFor(basePath);
  const text = serializeDebug(entries);
  const hash = hashText(text);
  const existed = fs.existsSync(file);
  const previous = existed ? fs.readFileSync(file, 'utf8') : null;
  if (previous === text) {
    return { written: false, backup: state?.backup || null, created: !existed, hash, entries };
  }
  let backup = state?.backup || null;
  if (existed && !state) {
    backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, text, 'utf8');
  return { written: true, backup, created: !existed || Boolean(backup && !existed), hash, entries };
}

export function restoreDebugFile(basePath, state) {
  const file = debugPathFor(basePath);
  if (state?.backup && fs.existsSync(state.backup)) {
    fs.copyFileSync(state.backup, file);
    return { restored: 'backup' };
  }
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return { restored: 'deleted' };
  }
  return { restored: 'none' };
}
