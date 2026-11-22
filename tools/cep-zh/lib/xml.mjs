// Tiny XML parser sufficient for CEP manifests and .debug files.
// Supports elements, attributes, text, comments, CDATA, processing instructions, DOCTYPE.
// Text nodes are { type: 'text', text }; elements are { type: 'element', name, attrs, children, parent }.

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return text.length;
}

export function parseXml(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const doc = { type: 'document', name: '#document', attrs: {}, children: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const addText = (raw) => {
    if (!raw) return;
    const value = decodeEntities(raw);
    if (value.trim() === '' && top().children.length === 0) return;
    top().children.push({ type: 'text', text: value, parent: top() });
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { addText(text.slice(i)); break; }
    if (lt > i) addText(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const value = text.slice(lt + 9, end < 0 ? text.length : end);
      top().children.push({ type: 'text', text: value, parent: top() });
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      let depth = 0;
      let j = lt;
      for (; j < text.length; j++) {
        if (text[j] === '<') depth++;
        else if (text[j] === '>') { depth--; if (depth === 0) { j++; break; } }
      }
      i = j;
      continue;
    }

    const gt = findTagEnd(text, lt + 1);
    let inner = text.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const el = { type: 'element', name, attrs: {}, children: [], parent: top() };
    const attrText = inner.slice(nameMatch[0].length);
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrText))) {
      const raw = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
      el.attrs[am[1]] = raw === undefined ? '' : decodeEntities(raw);
    }

    top().children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return doc;
}

export function elementChildren(el) {
  return (el?.children || []).filter((c) => c.type === 'element');
}

export function findAll(el, name, out = []) {
  for (const c of elementChildren(el)) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function findFirst(el, name) {
  for (const c of elementChildren(el)) {
    if (c.name === name) return c;
    const nested = findFirst(c, name);
    if (nested) return nested;
  }
  return null;
}

export function textOf(el) {
  if (!el) return '';
  let out = '';
  for (const c of el.children || []) {
    if (c.type === 'text') out += c.text;
    else out += textOf(c);
  }
  return out.trim();
}

export function attr(el, name, fallback = '') {
  return el?.attrs?.[name] ?? fallback;
}

export function childByName(el, name) {
  return elementChildren(el).find((c) => c.name === name) || null;
}
