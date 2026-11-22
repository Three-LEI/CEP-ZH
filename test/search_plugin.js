(() => {
  const p = document.getElementById('pluginSearch');
  p.value = 'flow';
  p.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({
    plugins: Array.from(document.querySelectorAll('.plugin-item')).map((x) => x.getAttribute('data-key')),
    rows: document.querySelectorAll('#pluginRows tr').length,
    dictSearch: document.getElementById('dictSearch').value
  });
})()
