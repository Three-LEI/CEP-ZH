/*
 * VCRUNTIME140.dll proxy for CEP 9 / CEF 3.3163 (Chromium 61).
 *
 * The old CEPHtmlEngine.exe imports VCRUNTIME140.dll (not VCRUNTIME140_1).
 * This DLL exports forwarders for all 71 VCRUNTIME140 exports to the renamed
 * original DLL, and hooks cef_initialize() to set remote_debugging_port.
 *
 * CEF 3.3163 cef_settings_t: sizeof=360, remote_debugging_port offset=316.
 */
#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PORT_OFFSET 316
#define MIN_SETTINGS_SIZE (PORT_OFFSET + 4)
static const char kMarker[] = "cep-zh CEP engine proxy v140 (CEF 3163)";
static HANDLE g_port_mutex;
static int g_port;
static char g_log[MAX_PATH];
static int(__cdecl* g_real)(const void*, void*, void*, void*);

static void log_line(const char* fmt, ...) {
    char b[1024];
    va_list ap;
    int n;
    HANDLE h;
    DWORD w;
    va_start(ap, fmt);
    n = _vsnprintf(b, sizeof(b) - 2, fmt, ap);
    va_end(ap);
    if (n < 0) n = 0;
    b[n++] = '\r';
    b[n++] = '\n';
    h = CreateFileA(g_log, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                    OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        WriteFile(h, b, (DWORD)n, &w, NULL);
        CloseHandle(h);
    }
}

static int __cdecl hook_cef_initialize(const void* args, void* settings, void* app, void* sandbox) {
    if (settings && g_port > 0) {
        size_t size = *(size_t*)settings;
        if (size >= MIN_SETTINGS_SIZE) {
            *(int*)((char*)settings + PORT_OFFSET) = g_port;
            log_line("cef_initialize size=%llu port=%d", (unsigned long long)size, g_port);
        } else {
            log_line("cef_initialize size=%llu too small (need %d)", (unsigned long long)size, MIN_SETTINGS_SIZE);
        }
    }
    return g_real ? g_real(args, settings, app, sandbox) : 0;
}

static int patch_iat(void) {
    BYTE* base = (BYTE*)GetModuleHandleW(NULL);
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
    IMAGE_NT_HEADERS64* nt;
    IMAGE_DATA_DIRECTORY dir;
    IMAGE_IMPORT_DESCRIPTOR* imp;
    HMODULE cef = GetModuleHandleW(L"libcef.dll");
    void* exp;
    if (!cef) return 0;
    exp = (void*)GetProcAddress(cef, "cef_initialize");
    if (!exp) return 0;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    nt = (IMAGE_NT_HEADERS64*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress) return 0;
    imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);
    for (; imp->Name; imp++) {
        IMAGE_THUNK_DATA64* o;
        IMAGE_THUNK_DATA64* f;
        if (_stricmp((char*)(base + imp->Name), "libcef.dll") != 0) continue;
        o = (IMAGE_THUNK_DATA64*)(base + (imp->OriginalFirstThunk ? imp->OriginalFirstThunk : imp->FirstThunk));
        f = (IMAGE_THUNK_DATA64*)(base + imp->FirstThunk);
        for (; o->u1.AddressOfData; o++, f++) {
            IMAGE_IMPORT_BY_NAME* nm;
            DWORD old;
            if (o->u1.Ordinal & 0x8000000000000000ULL) continue;
            nm = (IMAGE_IMPORT_BY_NAME*)(base + (DWORD)o->u1.AddressOfData);
            if (strcmp((char*)nm->Name, "cef_initialize") != 0) continue;
            if ((void*)f->u1.Function != exp) return 0;
            g_real = (int(__cdecl*)(const void*, void*, void*, void*))f->u1.Function;
            if (!VirtualProtect(&f->u1.Function, sizeof(void*), PAGE_READWRITE, &old)) return 0;
            f->u1.Function = (ULONG_PTR)hook_cef_initialize;
            VirtualProtect(&f->u1.Function, sizeof(void*), old, &old);
            return 1;
        }
    }
    return 0;
}

static DWORD WINAPI patch_thread(LPVOID p) {
    int i;
    (void)p;
    for (i = 0; i < 20000; i++) {
        if (patch_iat()) {
            log_line("IAT patched real=%p", (void*)g_real);
            return 0;
        }
        Sleep(1);
    }
    log_line("IAT patch failed");
    return 0;
}

static int choose_port(void) {
    char env[32];
    int base, i;
    GetEnvironmentVariableA("CEP_ZH_PORT", env, sizeof(env));
    if (env[0]) return atoi(env);
    base = 39600 + (int)(GetCurrentProcessId() % 500);
    for (i = 0; i < 500; i++) {
        wchar_t name[64];
        HANDLE m;
        _snwprintf(name, 64, L"Local\\CEPZH_PORT_%d", base + i);
        m = CreateMutexW(NULL, FALSE, name);
        if (m && GetLastError() != ERROR_ALREADY_EXISTS) {
            g_port_mutex = m;
            return base + i;
        }
        if (m) CloseHandle(m);
    }
    return base;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    char temp[MAX_PATH];
    (void)inst;
    (void)reserved;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(inst);
    GetTempPathA(MAX_PATH, temp);
    _snprintf(g_log, MAX_PATH, "%scepzh-proxy-v140.log", temp);
    if (strstr(GetCommandLineA(), "--type=")) return TRUE;
    g_port = choose_port();
    log_line("%s DllMain pid=%lu port=%d", kMarker, (unsigned long)GetCurrentProcessId(), g_port);
    CreateThread(NULL, 0, patch_thread, NULL, 0, NULL);
    return TRUE;
}

