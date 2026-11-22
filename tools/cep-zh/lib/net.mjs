// Windows process / listening-port helpers (no native dependencies).
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export function listCepProcessIds() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq CEPHtmlEngine.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    const ids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^"CEPHtmlEngine\.exe","(\d+)"/i.exec(line.trim());
      if (m) ids.push(Number(m[1]));
    }
    return ids;
  } catch {
    return [];
  }
}

/** @returns {{port:number, pid:number, address:string}[]} loopback listeners owned by CEP processes */
export function listCepListeningPorts() {
  const pids = new Set(listCepProcessIds());
  if (!pids.size) return [];
  let out;
  try {
    out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  } catch {
    return [];
  }
  const result = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    const state = cols[3];
    if (!/^LISTEN/i.test(state)) continue;
    const local = cols[1];
    const m = /^(.*):(\d+)$/.exec(local);
    if (!m) continue;
    const address = m[1];
    const port = Number(m[2]);
    const pid = Number(cols[4]);
    if (!pids.has(pid)) continue;
    if (!['127.0.0.1', '[::1]', '::1'].includes(address)) continue;
    result.push({ port, pid, address });
  }
  return result;
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export function canWriteDir(dir) {
  const probe = path.join(dir, '.cep-zh-write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
