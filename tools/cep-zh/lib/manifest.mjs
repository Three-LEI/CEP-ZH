// Parse a CEP extension manifest into a plain object.
import fs from 'node:fs';
import path from 'node:path';
import { parseXml, elementChildren, findAll, findFirst, textOf, attr } from './xml.mjs';

const local = (name) => (name.includes(':') ? name.split(':').pop() : name);

function findAllLocal(el, name, out = []) {
  for (const c of elementChildren(el)) {
    if (local(c.name) === name) out.push(c);
    findAllLocal(c, name, out);
  }
  return out;
}

function findFirstLocal(el, name) {
  for (const c of elementChildren(el)) {
    if (local(c.name) === name) return c;
    const nested = findFirstLocal(c, name);
    if (nested) return nested;
  }
  return null;
}

export function parseManifest(manifestPath) {
  const basePath = path.dirname(path.dirname(manifestPath));
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { ok: false, manifestPath, basePath, error: err.message };
  }
  let doc;
  try {
    doc = parseXml(text);
  } catch (err) {
    return { ok: false, manifestPath, basePath, error: 'XML: ' + err.message };
  }
  const root = findFirstLocal(doc, 'ExtensionManifest');
  if (!root) return { ok: false, manifestPath, basePath, error: 'no ExtensionManifest root' };

  const bundleId = attr(root, 'ExtensionBundleId') || path.basename(basePath);
  const bundleVersion = attr(root, 'ExtensionBundleVersion') || attr(root, 'Version');

  const hosts = [];
  const ee = findFirstLocal(root, 'ExecutionEnvironment');
  if (ee) {
    const hostList = findFirstLocal(ee, 'HostList');
    if (hostList) {
      for (const h of findAllLocal(hostList, 'Host')) {
        const name = attr(h, 'Name');
        if (name) hosts.push({ name, version: attr(h, 'Version') });
      }
    }
  }

  const declared = new Map();
  const extList = findFirstLocal(root, 'ExtensionList');
  if (extList) {
    for (const e of findAllLocal(extList, 'Extension')) {
      const id = attr(e, 'Id');
      if (id) declared.set(id, { id, version: attr(e, 'Version') });
    }
  }

  const extensions = [];
  const dispatchList = findFirstLocal(root, 'DispatchInfoList');
  if (dispatchList) {
    for (const ext of findAllLocal(dispatchList, 'Extension')) {
      const id = attr(ext, 'Id');
      if (!id) continue;
      const dispatch = findFirstLocal(ext, 'DispatchInfo');
      if (!dispatch) continue;
      const resources = findFirstLocal(dispatch, 'Resources');
      const mainPath = textOf(findFirstLocal(resources || dispatch, 'MainPath'));
      const scriptPath = textOf(findFirstLocal(resources || dispatch, 'ScriptPath'));
      const menu = textOf(findFirstLocal(dispatch, 'Menu'));
      const type = textOf(findFirstLocal(dispatch, 'Type'));
      const autoVisibleRaw = textOf(findFirstLocal(dispatch, 'AutoVisible'));
      const cefParams = findAllLocal(resources || dispatch, 'Parameter').map((p) => textOf(p)).filter(Boolean);
      let mainPathAbs = null;
      if (mainPath) {
        const clean = mainPath.replace(/^[.][\\/]/, '');
        mainPathAbs = path.resolve(basePath, clean);
      }
      extensions.push({
        id,
        version: declared.get(id)?.version || attr(ext, 'Version'),
        mainPath,
        mainPathAbs,
        scriptPath: scriptPath || null,
        menu: menu || id,
        type: type || '',
        autoVisible: autoVisibleStr(autoVisibleRaw),
        cefParams,
      });
    }
  }

  // CEP panels without DispatchInfoList entries still declare ids; keep them for menu/debug mapping.
  for (const [id, meta] of declared) {
    if (!extensions.some((e) => e.id === id)) {
      extensions.push({ id, version: meta.version, mainPath: null, mainPathAbs: null, menu: id, type: '', autoVisible: false, cefParams: [] });
    }
  }

  return {
    ok: true,
    manifestPath,
    basePath,
    bundleId,
    bundleVersion,
    hosts,
    extensions,
    raw: text,
  };
}

function autoVisibleStr(raw) {
  if (!raw) return false;
  return /^(true|1)$/i.test(raw.trim());
}

export { local, findAllLocal, findFirstLocal };
