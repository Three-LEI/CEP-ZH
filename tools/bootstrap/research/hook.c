#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PORT_OFFSET 372
static int g_port;
static char g_log[MAX_PATH];
static int (__cdecl *g_real)(const void*, void*, void*, void*);
static int __cdecl hook_cef_initialize(const void*, void*, void*, void*);

static void logf(const char* fmt, ...) {
    char buf[1024]; va_list ap; int n; HANDLE h; DWORD w;
    va_start(ap, fmt); n = _vsnprintf(buf, sizeof(buf)-2, fmt, ap); va_end(ap);
    if (n < 0) n = 0;
    buf[n++] = '\r'; buf[n++] = '\n';
    h = CreateFileA(g_log, FILE_APPEND_DATA, FILE_SHARE_READ|FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) { WriteFile(h, buf, (DWORD)n, &w, NULL); CloseHandle(h); }
}

static int patch_iat(void) {
    BYTE* base = (BYTE*)GetModuleHandleW(NULL);
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
    IMAGE_NT_HEADERS64* nt;
    IMAGE_DATA_DIRECTORY dir;
    IMAGE_IMPORT_DESCRIPTOR* imp;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    nt = (IMAGE_NT_HEADERS64*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress) return 0;
    imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);
    for (; imp->Name; imp++) {
        IMAGE_THUNK_DATA64* o; IMAGE_THUNK_DATA64* f;
        if (_stricmp((char*)(base + imp->Name), "libcef.dll") != 0) continue;
        o = (IMAGE_THUNK_DATA64*)(base + (imp->OriginalFirstThunk ? imp->OriginalFirstThunk : imp->FirstThunk));
        f = (IMAGE_THUNK_DATA64*)(base + imp->FirstThunk);
        for (; o->u1.AddressOfData; o++, f++) {
            IMAGE_IMPORT_BY_NAME* nm; DWORD old;
            if (o->u1.Ordinal & 0x8000000000000000ULL) continue;
            nm = (IMAGE_IMPORT_BY_NAME*)(base + (DWORD)o->u1.AddressOfData);
            if (strcmp((char*)nm->Name, "cef_initialize") != 0) continue;
            g_real = (int (__cdecl *)(const void*, void*, void*, void*))f->u1.Function;
            if (!VirtualProtect(&f->u1.Function, sizeof(void*), PAGE_READWRITE, &old)) return 0;
            f->u1.Function = (ULONG_PTR)hook_cef_initialize;
            VirtualProtect(&f->u1.Function, sizeof(void*), old, &old);
            return 1;
        }
    }
    return 0;
}

static int __cdecl hook_cef_initialize(const void* args, void* settings, void* app, void* sandbox) {
    if (settings && g_port > 0) {
        size_t size = *(size_t*)settings;
        if (size >= PORT_OFFSET + 4) {
            *(int*)((char*)settings + PORT_OFFSET) = g_port;
            logf("cef_initialize size=%llu port=%d", (unsigned long long)size, g_port);
        } else {
            logf("cef_initialize size=%llu too small", (unsigned long long)size);
        }
    }
    return g_real ? g_real(args, settings, app, sandbox) : 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    char port[32], temp[MAX_PATH];
    (void)inst; (void)reserved;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(inst);
    GetTempPathA(MAX_PATH, temp);
    _snprintf(g_log, MAX_PATH, "%scepzh-hook.log", temp);
    GetEnvironmentVariableA("CEP_ZH_PORT", port, sizeof(port));
    g_port = port[0] ? atoi(port) : 0;
    logf("DllMain pid=%lu port=%d", (unsigned long)GetCurrentProcessId(), g_port);
    if (patch_iat()) logf("IAT patched real=%p", (void*)g_real);
    else logf("IAT patch FAILED");
    return TRUE;
}