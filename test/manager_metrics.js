JSON.stringify({
  inner: [innerWidth, innerHeight],
  dpr: devicePixelRatio,
  scroll: [scrollX, scrollY],
  visibility: document.visibilityState,
  hidden: document.hidden,
  html: { scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight },
  body: { scrollH: document.body.scrollHeight, clientH: document.body.clientHeight, rect: document.body.getBoundingClientRect() },
  header: (() => { const h = document.querySelector('header'); if (!h) return null; const r = h.getBoundingClientRect(); const s = getComputedStyle(h); return { rect: r, display: s.display, visibility: s.visibility, opacity: s.opacity, color: s.color, height: s.height }; })(),
  h1: (() => { const h = document.querySelector('h1'); if (!h) return null; const r = h.getBoundingClientRect(); const s = getComputedStyle(h); return { rect: r, color: s.color, fontSize: s.fontSize, display: s.display }; })(),
  bodyStyle: (() => { const s = getComputedStyle(document.body); return { display: s.display, visibility: s.visibility, opacity: s.opacity, overflow: s.overflow, height: s.height }; })(),
  at20: (() => { const e = document.elementFromPoint(20, 20); return e ? e.tagName + '.' + e.className : null; })(),
  at200: (() => { const e = document.elementFromPoint(200, 200); return e ? e.tagName + '.' + e.className : null; })()
})
