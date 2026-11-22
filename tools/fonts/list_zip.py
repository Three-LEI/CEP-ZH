import struct, sys, urllib.request

URL = 'https://hyperos.mi.com/font-download/MiSans.zip'

def size_of(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(r.headers['Content-Length'])

def fetch(url, start, end):
    req = urllib.request.Request(url, headers={'Range': 'bytes=%d-%d' % (start, end)})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

size = size_of(URL)
print('size', size, file=sys.stderr)
tail = fetch(URL, max(0, size - 65536), size - 1)
pos = tail.rfind(b'PK\x05\x06')
if pos < 0:
    raise SystemExit('EOCD not found')
eocd = tail[pos:pos+22]
_, disk, cd_disk, n_disk, n_total, cd_size, cd_off, comment_len = struct.unpack('<4s4H2IH', eocd)
print('entries', n_total, 'cd_off', cd_off, 'cd_size', cd_size, file=sys.stderr)
cd = fetch(URL, cd_off, cd_off + cd_size - 1)
p = 0
for i in range(n_total):
    if cd[p:p+4] != b'PK\x01\x02':
        raise SystemExit('bad central at %d' % p)
    fields = struct.unpack('<4s6H3I5H2I', cd[p:p+46])
    (sig, vm, vn, flags, method, mtime, mdate, crc, csize, usize,
     nlen, elen, clen, disk_start, iattr, eattr, local_off) = fields
    name = cd[p+46:p+46+nlen]
    try: name = name.decode('utf-8')
    except UnicodeDecodeError: name = name.decode('cp437')
    print('%-50s %10d %10d off=%d method=%d' % (name, usize, csize, local_off, method))
    p += 46 + nlen + elen + clen
