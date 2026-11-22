(() => {
  document.querySelector('[data-tab="global"]').click();
  const ed = document.getElementById('globalEditor');
  const obj = JSON.parse(ed.value);
  obj.strings['InstallerTest'] = '安装测试';
  ed.value = JSON.stringify(obj, null, 2);
  document.getElementById('btnSaveGlobal').click();
  return JSON.stringify({ status: document.getElementById('status').textContent, has: ed.value.includes('InstallerTest') });
})()
