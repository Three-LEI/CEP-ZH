(() => {
  const t = document.getElementById('globalToggle');
  t.checked = false;
  t.dispatchEvent(new Event('change'));
  return 'off';
})()
