// Extract translatable strings from a live CEP panel over CDP.
// Usage: node catalog.mjs <debugPort> [--json out.json]
import fs from 'node:fs';
import { listTargets, connect, evaluate } from './lib/cdp.mjs';

const EXPR = String.raw`(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','CODE','PRE','SVG','CANVAS']);
  const ATTRS = ['title','placeholder','aria-label','alt','data-pt-title','tooltip'];
  const text = new Map(), attrs = new Map(), title = document.title;
  function bump(map, key) {
    const k = key.replace(/\s+/g, ' ').trim();
    if (!k) return;
    map.set(k, (map.get(k) || 0) + 1);
  }
  function visit(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const tag = n.tagName;
          if (SKIP.has(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('[contenteditable="true"], .notranslate, [translate="no"]')) return NodeFilter.FILTER_REJECT;
        const t = n.textContent.replace(/\s+/g, ' ').trim();
        if (!t || t.length > 120) return NodeFilter.FILTER_REJECT;
        if (/^[\d\s.,:%+\-脳x/()\[\]]+$/.test(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) if (n.nodeType === Node.TEXT_NODE) bump(text, n.textContent);
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      for (const a of ATTRS) if (el.hasAttribute(a)) bump(attrs, el.getAttribute(a));
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  }
  visit(document.body);
  for (const f of document.querySelectorAll('iframe')) {
    try { visit(f.contentDocument?.body); } catch (e) {}
  }
  return JSON.stringify({ title, url: location.href, text: [...text.entries()], attrs: [...attrs.entries()] });
})()`;

const port = process.argv[2];
const jsonIdx = process.argv.indexOf('--json');
const outFile = jsonIdx > 0 ? process.argv[jsonIdx + 1] : null;
if (!port) {
  console.error('usage: node catalog.mjs <debugPort> [--json out.json]');
  process.exit(2);
}
const targets = await listTargets(port);
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target on port ' + port);
const client = await connect(page.webSocketDebuggerUrl);
const raw = await evaluate(client, EXPR);
const data = JSON.parse(raw);
console.log('title:', data.title);
console.log('url:', data.url);
console.log('--- text nodes (' + data.text.length + ') ---');
for (const [s, c] of data.text) console.log(c + '\t' + s);
console.log('--- attributes (' + data.attrs.length + ') ---');
for (const [s, c] of data.attrs) console.log(c + '\t' + s);
if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf8');
  console.log('saved', outFile);
}
client.close();

