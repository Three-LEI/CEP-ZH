(() => {
  const inputs = Array.from(document.querySelectorAll('#pluginRows .tr-input'));
  const el = inputs.find((i) => i.getAttribute('data-orig') === 'linear');
  if (!el) return 'not found';
  el.value = '线性';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return 'saved';
})()
