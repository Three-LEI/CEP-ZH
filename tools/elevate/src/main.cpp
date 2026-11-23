// CEP-ZH elevated .debug writer.
// asInvoker + self-elevation via ShellExecuteEx("runas"), so the Agent can
// start it with CreateProcess and no PowerShell is involved.
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <algorithm>
#include <cwctype>
#include <iterator>
#include <string>
#include <vector>

namespace {

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring out((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
    return out;
}

std::string WideToUtf8(const std::wstring& s) {
    if (s.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n, nullptr, nullptr);
    return out;
}

std::wstring Lower(std::wstring s) {
    std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return (wchar_t)towlower(c); });
    return s;
}

std::wstring FullPath(const std::wstring& path) {
    DWORD n = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (!n) return path;
    std::wstring out((size_t)n, L'\0');
    if (!GetFullPathNameW(path.c_str(), n, out.data(), nullptr)) return path;
    while (!out.empty() && out.back() == L'\0') out.pop_back();
    return out;
}

std::wstring FileName(const std::wstring& path) {
    size_t p = path.find_last_of(L"\\/");
    return p == std::wstring::npos ? path : path.substr(p + 1);
}

bool EndsWithNoCase(const std::wstring& s, const std::wstring& suffix) {
    if (s.size() < suffix.size()) return false;
    return Lower(s.substr(s.size() - suffix.size())) == Lower(suffix);
}

bool ContainsNoCase(const std::wstring& s, const std::wstring& needle) {
    return Lower(s).find(Lower(needle)) != std::wstring::npos;
}

bool ReadBytes(const std::wstring& path, std::vector<char>& out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart < 0 || size.QuadPart > 8 * 1024 * 1024) {
        CloseHandle(h);
        return false;
    }
    out.resize((size_t)size.QuadPart);
    DWORD read = 0;
    bool ok = out.empty() || (ReadFile(h, out.data(), (DWORD)out.size(), &read, nullptr) && read == out.size());
    CloseHandle(h);
    return ok;
}

bool WriteBytes(const std::wstring& path, const std::vector<char>& data) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    bool ok = data.empty() || (WriteFile(h, data.data(), (DWORD)data.size(), &written, nullptr) && written == data.size());
    if (ok) FlushFileBuffers(h);
    CloseHandle(h);
    return ok;
}

bool WriteText(const std::wstring& path, const std::string& text) {
    std::vector<char> bytes(text.begin(), text.end());
    return WriteBytes(path, bytes);
}

std::wstring ErrorText(DWORD code) {
    wchar_t* buffer = nullptr;
    DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, 0, (LPWSTR)&buffer, 0, nullptr);
    std::wstring out = n && buffer ? std::wstring(buffer, n) : (L"error " + std::to_wstring(code));
    if (buffer) LocalFree(buffer);
    while (!out.empty() && (out.back() == L'\r' || out.back() == L'\n' || out.back() == L' ')) out.pop_back();
    return out;
}

bool IsElevated() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION elevation{};
    DWORD size = 0;
    bool elevated = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size)
        && elevation.TokenIsElevated;
    CloseHandle(token);
    return elevated;
}

bool ValidTarget(const std::wstring& path) {
    std::wstring full = Lower(FullPath(path));
    if (!EndsWithNoCase(FileName(path), L".debug")) return false;
    if (full.find(L"\\adobe\\") == std::wstring::npos) return false;
    return full.find(L"\\cep\\extensions\\") != std::wstring::npos
        || full.find(L"\\support files\\") != std::wstring::npos;
}

bool ValidSource(const std::wstring& path) {
    std::wstring full = Lower(FullPath(path));
    return full.find(L"\\cep-zh\\") != std::wstring::npos && EndsWithNoCase(FileName(path), L".debug");
}

std::vector<std::wstring> SplitTabs(const std::wstring& line) {
    std::vector<std::wstring> out;
    size_t start = 0;
    for (;;) {
        size_t p = line.find(L'\t', start);
        if (p == std::wstring::npos) {
            out.push_back(line.substr(start));
            break;
        }
        out.push_back(line.substr(start, p - start));
        start = p + 1;
    }
    return out;
}

struct Item {
    std::wstring target;
    std::wstring source;
    std::wstring backup;
};

int RunJob(const std::wstring& jobPath, const std::wstring& resultPath) {
    std::vector<char> jobBytes;
    if (!ReadBytes(jobPath, jobBytes)) {
        WriteText(resultPath, "V1\n");
        return 1;
    }
    std::wstring job = Utf8ToWide(std::string(jobBytes.begin(), jobBytes.end()));
    std::vector<Item> items;
    size_t pos = 0;
    bool header = false;
    while (pos <= job.size()) {
        size_t end = job.find(L'\n', pos);
        std::wstring line = job.substr(pos, end == std::wstring::npos ? std::wstring::npos : end - pos);
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        pos = end == std::wstring::npos ? job.size() + 1 : end + 1;
        if (line.empty()) continue;
        if (!header) {
            if (line != L"CEPZH-ELEVATE 1") break;
            header = true;
            continue;
        }
        auto cols = SplitTabs(line);
        if (cols.size() < 3) continue;
        items.push_back({ FullPath(cols[0]), FullPath(cols[1]), cols[2].empty() ? FullPath(cols[0]) + L".cep-zh.bak" : FullPath(cols[2]) });
    }

    std::string out = "V1\n";
    bool allOk = true;
    for (const auto& item : items) {
        std::wstring error;
        bool ok = false;
        bool created = false;
        if (!ValidTarget(item.target)) {
            error = L"target path rejected";
        } else if (!ValidSource(item.source)) {
            error = L"source path rejected";
        } else {
            std::vector<char> data;
            if (!ReadBytes(item.source, data)) {
                error = L"cannot read staged .debug";
            } else {
                DWORD attrs = GetFileAttributesW(item.target.c_str());
                bool existed = attrs != INVALID_FILE_ATTRIBUTES;
                if (existed && GetFileAttributesW(item.backup.c_str()) == INVALID_FILE_ATTRIBUTES) {
                    if (!CopyFileW(item.target.c_str(), item.backup.c_str(), FALSE)) {
                        error = L"backup failed: " + ErrorText(GetLastError());
                    }
                }
                if (error.empty()) {
                    std::wstring tmp = item.target + L".cep-zh.tmp";
                    if (!WriteBytes(tmp, data)) {
                        error = L"write temp failed: " + ErrorText(GetLastError());
                    } else if (!MoveFileExW(tmp.c_str(), item.target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                        error = L"replace failed: " + ErrorText(GetLastError());
                        DeleteFileW(tmp.c_str());
                    } else {
                        ok = true;
                        created = !existed;
                    }
                }
            }
        }
        if (!ok) allOk = false;
        out += WideToUtf8(item.target) + "\t" + (ok ? "1" : "0") + "\t" + (created ? "1" : "0")
            + "\t" + WideToUtf8(item.backup) + "\t" + WideToUtf8(error) + "\n";
    }
    WriteText(resultPath, out);
    return allOk ? 0 : 2;
}

int WriteCanceled(const std::wstring& resultPath, DWORD code) {
    std::string out = "V1\n";
    out += "\t0\t0\t\t" + WideToUtf8(ErrorText(code)) + "\n";
    WriteText(resultPath, out);
    return code == ERROR_CANCELLED ? 1223 : 1;
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring jobPath;
    std::wstring resultPath;
    if (argv) {
        for (int i = 1; i + 1 < argc; ++i) {
            std::wstring arg = argv[i];
            if (arg == L"--job") jobPath = argv[++i];
            else if (arg == L"--result") resultPath = argv[++i];
        }
        LocalFree(argv);
    }
    if (jobPath.empty() || resultPath.empty()) return 1;

    if (!IsElevated()) {
        wchar_t self[MAX_PATH * 4]{};
        if (!GetModuleFileNameW(nullptr, self, (DWORD)std::size(self))) return 1;
        std::wstring params = L"--job \"" + jobPath + L"\" --result \"" + resultPath + L"\"";
        SHELLEXECUTEINFOW sei{};
        sei.cbSize = sizeof(sei);
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = L"runas";
        sei.lpFile = self;
        sei.lpParameters = params.c_str();
        sei.nShow = SW_HIDE;
        if (!ShellExecuteExW(&sei)) {
            return WriteCanceled(resultPath, GetLastError());
        }
        DWORD code = 1;
        if (sei.hProcess) {
            WaitForSingleObject(sei.hProcess, INFINITE);
            GetExitCodeProcess(sei.hProcess, &code);
            CloseHandle(sei.hProcess);
        }
        return (int)code;
    }
    return RunJob(jobPath, resultPath);
}
