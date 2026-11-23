// Single source of truth for the product version.
// Usage: node scripts/stamp-version.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VERSION must be x.y.z');
const parts = version.split('.').map(Number);
const check = process.argv.includes('--check');
let changes = 0;

function replace(rel, transform) {
    const file = path.join(root, rel);
    const before = fs.readFileSync(file, 'utf8');
    const after = transform(before);
    if (after !== before) {
        changes++;
        if (check) console.log('out of date:', rel);
        else fs.writeFileSync(file, after, 'utf8');
    }
}

replace('product/cep.zh.manager/index.html', (s) =>
    s.replace(/(<span class="version">)v[0-9.]+(<\/span>)/, `$1v${version}$2`));

replace('product/cep.zh.manager/CSXS/manifest.xml', (s) =>
    s.replace(/ExtensionBundleVersion="[0-9.]+"/, `ExtensionBundleVersion="${version}"`)
     .replace(/(<Extension Id="[^"]+" Version=")[0-9.]+(")/g, `$1${version}$2`));

replace('installer/native/src/installer.h', (s) =>
    s.replace(/kCepZhVersion\[\] = L"[0-9.]+"/, `kCepZhVersion[] = L"${version}"`));

replace('installer/native/src/main.cpp', (s) =>
    s.replace(/安装器 v[0-9.]+/, `安装器 v${version}`));

replace('installer/native/src/installer.cpp', (s) =>
    s.replace(/github\.com\/Three-LEI\/CEP-ZH\/releases\/download\/v[0-9.]+/g,
        `github.com/Three-LEI/CEP-ZH/releases/download/v${version}`)
     .replace(/CEP-ZH-runtime-v[0-9.]+\.zip/g, `CEP-ZH-runtime-v${version}.zip`));

replace('installer/native/res/app.rc', (s) =>
    s.replace(/FILEVERSION [0-9,]+/, `FILEVERSION ${parts[0]},${parts[1]},${parts[2]},0`)
     .replace(/PRODUCTVERSION [0-9,]+/, `PRODUCTVERSION ${parts[0]},${parts[1]},${parts[2]},0`)
     .replace(/VALUE "FileVersion", "[0-9.]+"/, `VALUE "FileVersion", "${version}"`)
     .replace(/VALUE "ProductVersion", "[0-9.]+"/, `VALUE "ProductVersion", "${version}"`));

replace('installer/native/res/app.manifest', (s) =>
    s.replace(/(<assemblyIdentity[^>]*version=")[0-9.]+(")/, `$1${version}.0$2`));

if (check && changes) process.exit(1);
console.log(check ? `version check ok: ${version}` : `stamped ${version} (${changes} files updated)`);
