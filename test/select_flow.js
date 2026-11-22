(() => {
  const el = document.querySelector('.plugin-item[data-key="com.rendertom.flow"]');
  if (el) el.click();
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    title: document.getElementById('pluginTitle').textContent,
    rows: document.querySelectorAll('#pluginRows tr').length
  });
})()
