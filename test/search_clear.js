(() => {
  const p = document.getElementById('pluginSearch');
  p.value = '';
  p.dispatchEvent(new Event('input', { bubbles: true }));
  const d = document.getElementById('dictSearch');
  d.value = '';
  d.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({
    plugins: document.querySelectorAll('.plugin-item').length,
    rows: document.querySelectorAll('#pluginRows tr').length
  });
})()
