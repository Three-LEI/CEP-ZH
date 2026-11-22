"""Extract the official MiSans WOFF2 weights we embed in the manager UI.

Source: https://hyperos.mi.com/font-download/MiSans.zip
The archive is fetched with HTTP Range requests, so we do not need the full 228 MB.
"""
import os
import struct
import sys
import urllib.request
import zlib

URL = 'https://hyperos.mi.com/font-download/MiSans.zip'
TARGETS = {
    'MiSans/woff2/MiSans-Regular.woff2': 'MiSans-Regular.woff2',
    'MiSans/woff2/MiSans-Medium.woff2': 'MiSans-Medium.woff2',
}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                   'product', 'cep.zh.manager', 'fonts')


def fetch(start, end):
    req = urllib.request.Request(URL, headers={'Range': 'bytes=%d-%d' % (start, end)})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def size():
    req = urllib.request.Request(URL, method='HEAD')
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(r.headers['Content-Length'])


total = size()
tail = fetch(max(0, total - 65536), total - 1)
pos = tail.rfind(b'PK\x05\x06')
if pos < 0:
    raise SystemExit('EOCD not found')
_, _, _, _, n_total, cd_size, cd_off, _ = struct.unpack('<4s4H2IH', tail[pos:pos + 22])
cd = fetch(cd_off, cd_off + cd_size - 1)
p = 0
found = {}
for _ in range(n_total):
    fields = struct.unpack('<4s6H3I5H2I', cd[p:p + 46])
    (_, _, _, _, method, _, _, _, csize, _, nlen, elen, clen, _, _, _, local_off) = fields
    name = cd[p + 46:p + 46 + nlen].decode('utf-8')
    p += 46 + nlen + elen + clen
    if name in TARGETS:
        found[name] = (method, csize, local_off)

os.makedirs(OUT, exist_ok=True)
for name, (method, csize, local_off) in found.items():
    hdr = fetch(local_off, local_off + 29)
    if hdr[:4] != b'PK\x03\x04':
        raise SystemExit('bad local header for ' + name)
    nlen, elen = struct.unpack('<HH', hdr[26:30])
    data_off = local_off + 30 + nlen + elen
    raw = fetch(data_off, data_off + csize - 1)
    data = raw if method == 0 else zlib.decompress(raw, -15)
    out = os.path.join(OUT, TARGETS[name])
    with open(out, 'wb') as f:
        f.write(data)
    print('wrote', out, len(data))

print('done')
