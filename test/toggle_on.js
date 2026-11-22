(() => {
  const t = document.getElementById('globalToggle');
  t.checked = true;
  t.dispatchEvent(new Event('change'));
  return 'on';
})()
