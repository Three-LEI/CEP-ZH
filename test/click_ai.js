(() => {
  document.querySelector('.nav-item[data-view="plugin"]').click();
  const el = document.querySelector('.plugin-item[data-key="com.rendertom.flow"]');
  if (el) el.click();
  document.getElementById('btnAi').click();
  return JSON.stringify({ title: document.getElementById('pluginTitle').textContent, ai: document.getElementById('btnAi').textContent });
})()
