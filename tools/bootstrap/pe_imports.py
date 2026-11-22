import struct, sys
p=r"D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine\CEPHtmlEngine.exe"
b=open(p,'rb').read()
pe=struct.unpack_from('<I',b,0x3c)[0]
nsec=struct.unpack_from('<H',b,pe+6)[0]
opt=pe+24
magic=struct.unpack_from('<H',b,opt)[0]
dd=opt+(112 if magic==0x20b else 96)
imp_rva=struct.unpack_from('<I',b,dd+8)[0]
sec=opt+struct.unpack_from('<H',b,pe+20)[0]
def rva2off(r):
    for i in range(nsec):
        s=sec+i*40
        va,vs,raw=struct.unpack_from('<III',b,s+12),struct.unpack_from('<I',b,s+8)[0],struct.unpack_from('<I',b,s+20)[0]
        va=va[0]
        if va<=r<va+vs: return raw+(r-va)
    return 0
o=rva2off(imp_rva)
while True:
    oft,ts,fc,name_rva,ft=struct.unpack_from('<IIIII',b,o)
    if name_rva==0: break
    no=rva2off(name_rva); name=b[no:b.index(b'\0',no)].decode('ascii','replace')
    if name.lower()=='libcef.dll':
        t=oft or ft; idx=0
        while True:
            v=struct.unpack_from('<Q',b,rva2off(t)+idx*8)[0]
            if v==0: break
            if v>>63==0:
                n=rva2off(v & 0x7fffffff)+2
                fn=b[n:b.index(b'\0',n)].decode('ascii','replace')
                if 'initialize' in fn or 'create_browser' in fn or 'execute' in fn or 'settings' in fn:
                    print(fn)
            idx+=1
    o+=20
