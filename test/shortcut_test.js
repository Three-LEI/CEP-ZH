(() => {
  document.querySelector('.nav-item[data-view="about"]').click();
  document.getElementById('btnShortcutRecord').click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  return JSON.stringify({
    shortcut: document.getElementById('shortcutDisplay').textContent,
    status: document.getElementById('shortcutStatus').textContent,
    github: document.getElementById('githubUrl').textContent,
    githubHref: document.getElementById('githubLink').href,
    biliHref: document.getElementById('biliLink').href,
    biliText: document.getElementById('biliLink').textContent
  });
})()
