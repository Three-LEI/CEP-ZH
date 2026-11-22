// Extract translatable strings from a live panel (shared by catalog command and agent).
import fs from 'node:fs';
import path from 'node:path';

export const EXTRACT_EXPR = String.raw`(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','CODE','PRE','SVG','CANVAS']);
  const ATTRS = ['title','placeholder','aria-label','aria-placeholder','alt','data-pt-title','tooltip'];
  const text = new Map(), attrs = new Map();
  const bump = (map, key) => {
    const k = String(key).replace(/\s+/g, ' ').trim();
    if (!k) return;
    // Keep only strings with translatable Latin letters: skips pure Chinese,
    // pure numbers and pure punctuation/symbols. U+00D7/U+00F7 are excluded.
    if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(k)) return;
    // Skip obvious CSS/SVG/JS fragments that some panels keep in text nodes.
    if (/[{}]/.test(k)) return;
    if (/(?:fill|stroke|font-size|font-family|background|opacity|color|margin|padding|display)\s*:/i.test(k)) return;
    if (/^(?:https?|file):\/\//i.test(k)) return;
    map.set(k, (map.get(k) || 0) + 1);
  };
  function visit(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP.has(n.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('[contenteditable="true"], .notranslate, [translate="no"]')) return NodeFilter.FILTER_REJECT;
        const t = n.textContent.replace(/\s+/g, ' ').trim();
        if (!t || t.length > 160) return NodeFilter.FILTER_REJECT;
        if (!/[A-Za-z\u00C0-\u024F]/.test(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) if (n.nodeType === Node.TEXT_NODE) bump(text, n.textContent);
    for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) {
      for (const a of ATTRS) if (el.hasAttribute(a)) bump(attrs, el.getAttribute(a));
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  }
  visit(document.body);
  for (const f of document.querySelectorAll('iframe')) {
    try { visit(f.contentDocument && f.contentDocument.body); } catch (e) {}
  }
  return JSON.stringify({ title: document.title, url: location.href, text: [...text.entries()], attrs: [...attrs.entries()] });
})()`;

export function mergeCatalog(existing, extracted, meta) {
  const out = existing || {
    bundleId: meta.bundleId || '',
    extIds: [],
    title: '',
    url: '',
    updatedAt: '',
    strings: {},
    attrs: {},
  };
  out.title = extracted.title || out.title;
  out.url = extracted.url || out.url;
  out.updatedAt = new Date().toISOString();
  if (meta.extId && !out.extIds.includes(meta.extId)) out.extIds.push(meta.extId);
  for (const [s, count] of extracted.text) out.strings[s] = (out.strings[s] || 0) + count;
  for (const [s, count] of extracted.attrs) out.attrs[s] = (out.attrs[s] || 0) + count;
  return out;
}

export function catalogPathFor(dir, key) {
  const safe = String(key || 'unknown').replace(/[^\w.-]+/g, '_');
  return path.join(dir, safe + '.json');
}

export function saveCatalog(dir, key, catalog) {
  fs.mkdirSync(dir, { recursive: true });
  const file = catalogPathFor(dir, key);
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2), 'utf8');
  return file;
}
