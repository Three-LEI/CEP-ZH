import { scanExtensions, extensionsForHosts } from '../tools/cep-zh/lib/scan.mjs';
import { allocatePorts, loadState } from '../tools/cep-zh/lib/ports.mjs';

const t0 = Date.now();
const scan = scanExtensions();
console.log('scan ms', Date.now() - t0);
console.log('roots', scan.roots.length, 'bundles', scan.bundles.length, 'errors', scan.errors.length);
for (const e of scan.errors.slice(0, 10)) console.log('ERR', e.manifestPath, e.error);
const testBundle = scan.bundles.find((b) => b.bundleId === 'cep.zh.test');
console.log('test bundle found:', Boolean(testBundle), testBundle?.debug, testBundle?.extensions.map((e) => e.id));
console.log('sample bundles:', scan.bundles.slice(0, 5).map((b) => `${b.bundleId}@${b.bundleVersion} [${b.hosts.map((h) => h.name).join(',')}] exts=${b.extensions.length}`));
const hosts = ['AEFT'];
const targets = extensionsForHosts(scan, hosts);
console.log('AEFT ext targets', targets.length, 'unique ext ids', new Set(targets.map((t) => t.ext.id)).size);
const { allocations, warnings } = await allocatePorts(targets.slice(0, 40), { state: loadState(), startPort: 39400 });
console.log('alloc sample', allocations.slice(0, 6).map((a) => `${a.port} ${a.host} ${a.ext.id} (${a.source})`));
console.log('warnings', warnings.slice(0, 5));
