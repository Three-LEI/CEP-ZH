(() => {
  const s = document.getElementById('themeSelect');
  s.value = 'light';
  s.dispatchEvent(new Event('change'));
  return document.documentElement.getAttribute('data-theme');
})()
