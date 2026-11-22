// Verify .debug backup/merge/restore behavior on a temporary folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { writeDebugFile, restoreDebugFile, readDebugFile } from '../tools/cep-zh/lib/debugfile.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cep-zh-test-'));
const file = path.join(dir, '.debug');
const original = `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="existing">
    <HostList>
      <Host Name="AEFT" Port="8001" />
    </HostList>
  </Extension>
</ExtensionList>
`;
fs.writeFileSync(file, original, 'utf8');

const res = writeDebugFile(dir, { existing: { AEFT: 8001 }, added: { AEFT: 8002 } });
assert.ok(res.written, 'should write');
assert.ok(fs.existsSync(file + '.cep-zh.bak'), 'backup should exist');
const parsed = readDebugFile(dir);
assert.strictEqual(parsed.existing.AEFT, 8001);
assert.strictEqual(parsed.added.AEFT, 8002);

restoreDebugFile(dir, res);
assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'restore should bring original back');
fs.rmSync(dir, { recursive: true, force: true });
console.log('debugfile test ok');
