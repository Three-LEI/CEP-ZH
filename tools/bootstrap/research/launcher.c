#include <windows.h>
#define CP_ACP 0
int __stdcall WideCharToMultiByte(unsigned int, unsigned long, const WCHAR*, int, char*, int, const char*, int*);
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char g_log[MAX_PATH];

static void logf(const char* fmt, ...) {
    char buf[1024]; va_list ap; int n; HANDLE h; DWORD w;
    va_start(ap, fmt); n = _vsnprintf(buf, sizeof(buf)-2, fmt, ap); va_end(ap);
    if (n < 0) n = 0;
    buf[n++] = '\r'; buf[n++] = '\n';
    h = CreateFileA(g_log, FILE_APPEND_DATA, FILE_SHARE_READ|FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) { WriteFile(h, buf, (DWORD)n, &w, NULL); CloseHandle(h); }
}

static void w2a(const WCHAR* w, char* a, int n) { WideCharToMultiByte(CP_ACP, 0, w, -1, a, n, NULL, NULL); }

static void dir_of(const WCHAR* path, WCHAR* out) {
    int i = (int)wcslen(path);
    while (i > 0 && path[i-1] != L'\\' && path[i-1] != L'/') i--;
    wcsncpy(out, path, i); out[i] = 0;
}

static const WCHAR* args_part(const WCHAR* cmd) {
    const WCHAR* p = cmd;
    if (*p == L'"') { p++; while (*p && *p != L'"') p++; if (*p == L'"') p++; }
    else { while (*p && *p != L' ' && *p != L'\t') p++; }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

int main(void) {
    WCHAR self[MAX_PATH], dir[MAX_PATH], real[MAX_PATH], hook[MAX_PATH], cmd[32768], portw[32], tempw[MAX_PATH];
    char reala[MAX_PATH], hooka[MAX_PATH], selfa[MAX_PATH];
    STARTUPINFOW si; PROCESS_INFORMATION pi; CONTEXT ctx;
    void* remote; unsigned char code[64]; int n = 0, port;
    ULONG_PTR path_addr, load_lib, entry;
    DWORD oldp; SIZE_T path_bytes, code_len; DWORD exit_code = 0;
    WCHAR* cmdline;

    GetTempPathW(MAX_PATH, tempw); w2a(tempw, g_log, MAX_PATH);
    strcat(g_log, "cepzh-launcher.log");

    GetModuleFileNameW(NULL, self, MAX_PATH);
    dir_of(self, dir);

    if (GetEnvironmentVariableW(L"CEP_ZH_REAL", real, MAX_PATH) == 0)
        _snwprintf(real, MAX_PATH, L"%s\\CEPHtmlEngine.real.exe", dir);
    if (GetEnvironmentVariableW(L"CEP_ZH_HOOK", hook, MAX_PATH) == 0)
        _snwprintf(hook, MAX_PATH, L"%s\\cepzh-hook.dll", dir);
    if (GetEnvironmentVariableW(L"CEP_ZH_PORT", portw, 32) == 0) {
        port = 39600 + (int)(GetCurrentProcessId() % 300);
        _snwprintf(portw, 32, L"%d", port);
    } else {
        port = _wtoi(portw);
    }
    SetEnvironmentVariableW(L"CEP_ZH_PORT", portw);

    w2a(self, selfa, MAX_PATH); w2a(real, reala, MAX_PATH); w2a(hook, hooka, MAX_PATH);
    logf("launcher pid=%lu self=%s real=%s hook=%s port=%d", (unsigned long)GetCurrentProcessId(), selfa, reala, hooka, port);

    cmdline = GetCommandLineW();
    _snwprintf(cmd, 32768, L"\"%s\" %s", real, args_part(cmdline));

    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(real, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
        logf("CreateProcess failed %lu", (unsigned long)GetLastError()); return 2;
    }

    ZeroMemory(&ctx, sizeof(ctx)); ctx.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(pi.hThread, &ctx)) { logf("GetThreadContext failed %lu", (unsigned long)GetLastError()); TerminateProcess(pi.hProcess, 3); return 3; }
    entry = ctx.Rip;

    remote = VirtualAllocEx(pi.hProcess, NULL, 8192, MEM_COMMIT|MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!remote) { logf("VirtualAllocEx failed %lu", (unsigned long)GetLastError()); TerminateProcess(pi.hProcess, 4); return 4; }
    path_addr = (ULONG_PTR)remote; path_bytes = (wcslen(hook)+1)*sizeof(WCHAR);

    code[n++]=0x48; code[n++]=0x83; code[n++]=0xEC; code[n++]=0x28;
    code[n++]=0x48; code[n++]=0xB9; memcpy(code+n,&path_addr,8); n+=8;
    load_lib = (ULONG_PTR)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    code[n++]=0x48; code[n++]=0xB8; memcpy(code+n,&load_lib,8); n+=8;
    code[n++]=0xFF; code[n++]=0xD0;
    code[n++]=0x48; code[n++]=0x83; code[n++]=0xC4; code[n++]=0x28;
    code[n++]=0x48; code[n++]=0xB8; memcpy(code+n,&entry,8); n+=8;
    code[n++]=0xFF; code[n++]=0xE0;
    code_len = (SIZE_T)n;

    if (!WriteProcessMemory(pi.hProcess, (void*)path_addr, hook, path_bytes, NULL) ||
        !WriteProcessMemory(pi.hProcess, (void*)((ULONG_PTR)remote+0x400), code, code_len, NULL)) {
        logf("WriteProcessMemory failed %lu", (unsigned long)GetLastError()); TerminateProcess(pi.hProcess, 5); return 5;
    }
    VirtualProtectEx(pi.hProcess, (void*)path_addr, 8192, PAGE_EXECUTE_READWRITE, &oldp);
    ctx.Rip = (DWORD64)((ULONG_PTR)remote + 0x400);
    if (!SetThreadContext(pi.hThread, &ctx)) { logf("SetThreadContext failed %lu", (unsigned long)GetLastError()); TerminateProcess(pi.hProcess, 6); return 6; }
    ResumeThread(pi.hThread); CloseHandle(pi.hThread);
    logf("resumed child pid=%lu entry=%p shellcode=%p", (unsigned long)pi.dwProcessId, (void*)entry, (void*)ctx.Rip);
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exit_code);
    logf("child exited %lu", (unsigned long)exit_code);
    CloseHandle(pi.hProcess);
    return (int)exit_code;
}