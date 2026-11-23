// Builds and signs CEP-ZH-manifest.json.
// Usage: node scripts/sign-manifest.mjs <runtime.zip> <installer.exe> [outputDir]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const runtime = process.argv[2];
const installer = process.argv[3];
const outDir = process.argv[4] || path.join(root, '.tmp-release');
if (!runtime || !installer) {
    console.error('usage: node scripts/sign-manifest.mjs <runtime.zip> <installer.exe> [outputDir]');
    process.exit(2);
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runtimeName = `CEP-ZH-runtime-v${version}.zip`;
const manifest = {
    version,
    runtime: runtimeName,
    runtimeSha256: hash(runtime),
    installer: 'CepZhInstaller.exe',
    installerVersion: version,
    installerSha256: hash(installer)
};
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const privateKey = fs.readFileSync(path.join(root, 'tools', 'release', 'private.pem'), 'utf8');
const signature = crypto.sign('sha256', bytes, privateKey);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'CEP-ZH-manifest.json'), bytes);
fs.writeFileSync(path.join(outDir, 'CEP-ZH-manifest.sig'), signature);
console.log(JSON.stringify(manifest, null, 2));
console.log('signature bytes:', signature.length);
