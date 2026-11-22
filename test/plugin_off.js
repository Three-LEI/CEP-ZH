(() => {
  const t = document.getElementById('pluginToggle');
  t.checked = false;
  t.dispatchEvent(new Event('change'));
  return 'plugin-off';
})()
