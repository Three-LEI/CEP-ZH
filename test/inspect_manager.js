JSON.stringify({
  ready: document.readyState,
  title: document.title,
  href: location.href,
  bodyLen: document.body ? document.body.innerHTML.length : -1,
  text: document.body ? document.body.innerText.slice(0, 1200) : '',
  html: document.documentElement.outerHTML.slice(0, 600),
  hasCep: typeof window.__adobe_cep__,
  hasFs: !!(window.cep && window.cep.fs),
  scripts: Array.from(document.scripts).map(s => s.src),
  styleSheets: document.styleSheets.length,
  bodyBg: getComputedStyle(document.body).backgroundColor
})
