(() => {
  const folder = 'C:/Users/LEI/AppData/Local/Temp/cepzh-import-folder';
  const el = document.getElementById('importOverwrite');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify(window.__CEP_ZH_MANAGER_TEST__.importFrom(folder));
})()
