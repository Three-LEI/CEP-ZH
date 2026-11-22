/*
 * cepzh-launcher.exe - starts the real CEPHtmlEngine and loads cepzh-hook.dll
 * before the engine's entry point, so cef_initialize() gets a debug port even
 * when no .debug file exists.
 *
 * For a test run:
 *   cepzh-launcher.exe <same args CEP would pass to CEPHtmlEngine.exe>
 * with CEP_ZH_REAL pointing at the real CEPHtmlEngine.exe and CEP_ZH_PORT set.
 *
 * Build: tcc -o cepzh-launcher.exe cepzh-launcher.c
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

static void dir_of(const WCHAR *path, WCHAR *out) {
    int i = (int)wcslen(path);
    while (i > 0 && path[i - 1] != L'\\' && path[i - 1] != L'/') i--;
    wcsncpy(out, path, i);
    out[i] = 0;
}

static const WCHAR *args_part(const WCHAR *cmd) {
    const WCHAR *p = cmd;
    if (*p == L'"') {
        p++;
        while (*p && *p != L'"') p++;
        if (*p == L'"') p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t') p++;
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

int wmain(int argc, WCHAR **argv) {
    WCHAR self[MAX_PATH], dir[MAX_PATH], real[MAX_PATH], hook[MAX_PATH], cmd[32768];
    WCHAR port_buf[32], log_dir[MAX_PATH], log_path_w[MAX_PATH];
    WCHAR *cmdline;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    SIZE_T path_bytes;
    void *remote;
    HANDLE thread;
    DWORD thread_exit = 0;
    FARPROC load_lib;
    int port;
    (void)argc; (void)argv;

    GetTempPathW(MAX_PATH, log_dir);
    _snwprintf(log_path_w, MAX_PATH, L"%scepzh-launcher.log", log_dir);
    WideCharToMultiByte(CP_ACP, 0, log_path_w, -1, g_log_path, MAX_PATH, NULL, NULL);

    GetModuleFileNameW(NULL, self, MAX_PATH);
    dir_of(self, dir);

    if (GetEnvironmentVariableW(L"CEP_ZH_REAL", real, MAX_PATH) == 0) {
        _snwprintf(real, MAX_PATH, L"%s\\CEPHtmlEngine.real.exe", dir);
    }
    if (GetEnvironmentVariableW(L"CEP_ZH_HOOK", hook, MAX_PATH) == 0) {
        _snwprintf(hook, MAX_PATH, L"%s\\cepzh-hook.dll", dir);
    }
    if (GetEnvironmentVariableW(L"CEP_ZH_PORT", port_buf, 32) == 0) {
        port = 39600 + (int)(GetCurrentProcessId() % 300);
        _snwprintf(port_buf, 32, L"%d", port);
    } else {
        port = _wtoi(port_buf);
    }
    SetEnvironmentVariableW(L"CEP_ZH_PORT", port_buf);

    log_line("launcher pid=%lu real=%ls hook=%ls port=%d", (unsigned long)GetCurrentProcessId(), real, hook, port);

    cmdline = GetCommandLineW();
    _snwprintf(cmd, 32768, L"\"%s\" %s", real, args_part(cmdline));

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(real, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
        log_line("CreateProcess failed %lu", (unsigned long)GetLastError());
        return 2;
    }

    remote = VirtualAllocEx(pi.hProcess, NULL, 8192, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        log_line("VirtualAllocEx failed %lu", (unsigned long)GetLastError());
        TerminateProcess(pi.hProcess, 4);
        return 4;
    }
    path_bytes = (wcslen(hook) + 1) * sizeof(WCHAR);
    if (!WriteProcessMemory(pi.hProcess, remote, hook, path_bytes, NULL)) {
        log_line("WriteProcessMemory failed %lu", (unsigned long)GetLastError());
        TerminateProcess(pi.hProcess, 5);
        return 5;
    }
    load_lib = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    thread = CreateRemoteThread(pi.hProcess, NULL, 0, (LPTHREAD_START_ROUTINE)load_lib, remote, 0, NULL);
    if (!thread) {
        log_line("CreateRemoteThread failed %lu", (unsigned long)GetLastError());
        TerminateProcess(pi.hProcess, 6);
        return 6;
    }
    WaitForSingleObject(thread, 10000);
    GetExitCodeThread(thread, &thread_exit);
    CloseHandle(thread);
    if (!thread_exit) {
        log_line("LoadLibraryW returned 0");
        TerminateProcess(pi.hProcess, 7);
        return 7;
    }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    log_line("resumed child pid=%lu hook=%ls module=%p", (unsigned long)pi.dwProcessId, hook, (void *)(ULONG_PTR)thread_exit);
    WaitForSingleObject(pi.hProcess, INFINITE);
    {
        DWORD code_exit = 0;
        GetExitCodeProcess(pi.hProcess, &code_exit);
        log_line("child exited %lu", (unsigned long)code_exit);
        CloseHandle(pi.hProcess);
        return (int)code_exit;
    }
}
