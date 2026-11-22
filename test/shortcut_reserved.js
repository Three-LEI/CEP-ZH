(() => {
  document.getElementById('btnShortcutRecord').click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, bubbles: true, cancelable: true }));
  return JSON.stringify({
    shortcut: document.getElementById('shortcutDisplay').textContent,
    status: document.getElementById('shortcutStatus').textContent
  });
})()
