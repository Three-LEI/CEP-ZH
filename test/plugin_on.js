(() => {
  const t = document.getElementById('pluginToggle');
  t.checked = true;
  t.dispatchEvent(new Event('change'));
  return 'plugin-on';
})()
