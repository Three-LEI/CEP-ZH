/* Minimal CEPHtmlEngine command-line wrapper for testing the documented
 * CEF --remote-debugging-port switch on CEP 9. It launches the renamed real
 * engine and waits, so the Adobe host still sees one foreground child. */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static wchar_t g_log[MAX_PATH];

static void log_line(const wchar_t* fmt, ...) {
    wchar_t buf[2048];
    va_list ap;
    int n;
    HANDLE h;
    DWORD written;
    va_start(ap, fmt);
    n = _vsnwprintf(buf, 2046, fmt, ap);
    va_end(ap);
    if (n < 0) n = 0;
    buf[n++] = L'\r';
    buf[n++] = L'\n';
    h = CreateFileW(g_log, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                    OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        WriteFile(h, buf, (DWORD)(n * sizeof(wchar_t)), &written, NULL);
        CloseHandle(h);
    }
}

static void dir_of(const wchar_t* path, wchar_t* out, size_t cch) {
    int i = (int)wcslen(path);
    while (i > 0 && path[i - 1] != L'\\' && path[i - 1] != L'/') i--;
    wcsncpy(out, path, i);
    out[i] = 0;
}

static const wchar_t* args_after_exe(const wchar_t* cmd) {
    const wchar_t* p = cmd;
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

int wmain(void) {
    wchar_t self[MAX_PATH], dir[MAX_PATH], real[MAX_PATH], cmd[32768], port[16];
    const wchar_t* args;
    DWORD n;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD exit_code = 1;
    int p;

    GetTempPathW(MAX_PATH, g_log);
    wcscat(g_log, L"cepzh-cmdline-wrapper.log");

    GetModuleFileNameW(NULL, self, MAX_PATH);
    dir_of(self, dir, MAX_PATH);
    _snwprintf(real, MAX_PATH, L"%sCEPHtmlEngine.real.exe", dir);
    args = args_after_exe(GetCommandLineW());
    n = GetEnvironmentVariableW(L"CEP_ZH_PORT", port, 16);
    p = n ? _wtoi(port) : (39700 + (int)(GetCurrentProcessId() % 200));
    if (GetEnvironmentVariableW(L"CEP_ZH_ADD_PORT", port, 16))
        _snwprintf(cmd, 32768, L"\"%s\" --remote-debugging-port=%d %s", real, p, args);
    else
        _snwprintf(cmd, 32768, L"\"%s\" %s", real, args);
    log_line(L"wrapper pid=%lu port=%d cmd=%ls", GetCurrentProcessId(), p, cmd);

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(real, cmd, NULL, NULL, TRUE, 0, NULL, dir, &si, &pi)) {
        log_line(L"CreateProcess failed %lu", GetLastError());
        return 2;
    }
    log_line(L"child pid=%lu", pi.dwProcessId);
    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exit_code);
    log_line(L"child exit=%lu", exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)exit_code;
}
