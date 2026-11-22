/*
 * cepzh-hook.dll - loaded into CEPHtmlEngine.exe before its entry point.
 *
 * It patches the IAT entry for cef_initialize and forces
 * cef_settings_t.remote_debugging_port (offset 372 in CEF 99) to the port in
 * the CEP_ZH_PORT environment variable. This gives every CEP panel a DevTools
 * port without a per-extension .debug file.
 *
 * Build: tcc -shared -o cepzh-hook.dll cepzh-hook.c
 */
#include <windows.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>

#define CEF99_SETTINGS_PORT_OFFSET 372
#define CEF99_SETTINGS_MIN_SIZE (372 + 4)

typedef int (__cdecl *cef_initialize_fn)(const void *args, void *settings, void *app, void *sandbox_info);

static int __cdecl hook_cef_initialize(const void *args, void *settings, void *app, void *sandbox_info);

static cef_initialize_fn g_real_cef_initialize = 0;
static int g_port = 0;
static char g_log_path[MAX_PATH];

static void log_line(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    int n;
    HANDLE h;
    DWORD written;
    va_start(ap, fmt);
    n = _vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
    va_end(ap);
    if (n < 0) n = 0;
    buf[n++] = '\r';
    buf[n++] = '\n';
    h = CreateFileA(g_log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                    OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        WriteFile(h, buf, (DWORD)n, &written, NULL);
        CloseHandle(h);
    }
}

static int patch_iat(void) {
    HMODULE main_module = GetModuleHandleW(NULL);
    BYTE *base = (BYTE *)main_module;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    IMAGE_NT_HEADERS64 *nt;
    IMAGE_DATA_DIRECTORY imports;
    IMAGE_IMPORT_DESCRIPTOR *desc;
    DWORD old_protect;

    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    nt = (IMAGE_NT_HEADERS64 *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    imports = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!imports.VirtualAddress) return 0;

    desc = (IMAGE_IMPORT_DESCRIPTOR *)(base + imports.VirtualAddress);
    for (; desc->Name; desc++) {
        char *dll_name = (char *)(base + desc->Name);
        IMAGE_THUNK_DATA64 *orig;
        IMAGE_THUNK_DATA64 *first;
        if (_stricmp(dll_name, "libcef.dll") != 0) continue;
        orig = (IMAGE_THUNK_DATA64 *)(base + (desc->OriginalFirstThunk ? desc->OriginalFirstThunk : desc->FirstThunk));
        first = (IMAGE_THUNK_DATA64 *)(base + desc->FirstThunk);
        for (; orig->u1.AddressOfData; orig++, first++) {
            IMAGE_IMPORT_BY_NAME *by_name;
            if (orig->u1.Ordinal & IMAGE_ORDINAL_FLAG64) continue;
            by_name = (IMAGE_IMPORT_BY_NAME *)(base + (DWORD)orig->u1.AddressOfData);
            if (strcmp((char *)by_name->Name, "cef_initialize") != 0) continue;
            g_real_cef_initialize = (cef_initialize_fn)first->u1.Function;
            if (!VirtualProtect(&first->u1.Function, sizeof(void *), PAGE_READWRITE, &old_protect))
                return 0;
            first->u1.Function = (ULONG_PTR)hook_cef_initialize;
            VirtualProtect(&first->u1.Function, sizeof(void *), old_protect, &old_protect);
            return 1;
        }
    }
    return 0;
}

static int __cdecl hook_cef_initialize(const void *args, void *settings, void *app, void *sandbox_info) {
    if (settings && g_port > 0) {
        size_t size = *(size_t *)settings;
        if (size >= CEF99_SETTINGS_MIN_SIZE) {
            *(int *)((char *)settings + CEF99_SETTINGS_PORT_OFFSET) = g_port;
            log_line("cef_initialize: size=%llu port=%d", (unsigned long long)size, g_port);
        } else {
            log_line("cef_initialize: size=%llu too small", (unsigned long long)size);
        }
    }
    if (g_real_cef_initialize) return g_real_cef_initialize(args, settings, app, sandbox_info);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    char port_buf[32];
    char temp[MAX_PATH];
    (void)instance; (void)reserved;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(instance);

    GetTempPathA(MAX_PATH, temp);
    _snprintf(g_log_path, MAX_PATH, "%scepzh-hook.log", temp);

    GetEnvironmentVariableA("CEP_ZH_PORT", port_buf, sizeof(port_buf));
    g_port = port_buf[0] ? atoi(port_buf) : 0;

    log_line("DllMain pid=%lu port=%d", (unsigned long)GetCurrentProcessId(), g_port);
    if (patch_iat()) log_line("IAT patched cef_initialize=%p", (void *)g_real_cef_initialize);
    else log_line("IAT patch FAILED");
    return TRUE;
}

