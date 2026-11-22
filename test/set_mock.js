(() => {
  document.querySelector('.nav-item[data-view="settings"]').click();
  const p = document.getElementById('apiProvider');
  p.value = 'mock';
  p.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btnSaveApi').click();
  return JSON.stringify({ provider: p.value, saved: true });
})()
