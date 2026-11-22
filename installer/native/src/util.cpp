#include "util.h"

#include <shlobj.h>
#include <shellapi.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;

std::wstring JoinPath(const std::wstring& a, const std::wstring& b)
{
    if (a.empty()) return b;
    if (b.empty()) return a;
    wchar_t last = a.back();
    if (last == L'\\' || last == L'/') return a + b;
    return a + L"\\" + b;
}

std::wstring KnownFolder(REFKNOWNFOLDERID id)
{
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &raw)) || !raw)
        return std::wstring();
    std::wstring out(raw);
    CoTaskMemFree(raw);
    return out;
}

std::wstring TempDirectory()
{
    wchar_t buffer[MAX_PATH * 2] = {};
    DWORD len = GetTempPathW(static_cast<DWORD>(std::size(buffer)), buffer);
    if (!len) return L"C:\\Windows\\Temp";
    std::wstring out(buffer, len);
    while (!out.empty() && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    return out;
}

std::wstring ExeDirectory()
{
    return DirectoryOf(ModulePath());
}

std::wstring ModulePath()
{
    wchar_t buffer[MAX_PATH * 4] = {};
    DWORD len = GetModuleFileNameW(nullptr, buffer, static_cast<DWORD>(std::size(buffer)));
    if (!len) return std::wstring();
    return std::wstring(buffer, len);
}

std::wstring FileNameOf(const std::wstring& path)
{
    const size_t pos = path.find_last_of(L"\\/");
    return pos == std::wstring::npos ? path : path.substr(pos + 1);
}

std::wstring DirectoryOf(const std::wstring& path)
{
    const size_t pos = path.find_last_of(L"\\/");
    return pos == std::wstring::npos ? std::wstring() : path.substr(0, pos);
}

bool FileExists(const std::wstring& path)
{
    const DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirectoryExists(const std::wstring& path)
{
    const DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

bool EnsureDirectory(const std::wstring& path)
{
    if (path.empty()) return false;
    std::error_code ec;
    fs::create_directories(fs::path(path), ec);
    return !ec;
}

bool RemoveTree(const std::wstring& path)
{
    if (!DirectoryExists(path)) return true;
    std::error_code ec;
    fs::remove_all(fs::path(path), ec);
    return !ec;
}

bool CopyTree(const std::wstring& from, const std::wstring& to)
{
    std::error_code ec;
    fs::copy(fs::path(from), fs::path(to),
        fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
    return !ec;
}

bool CopyFileSimple(const std::wstring& from, const std::wstring& to)
{
    EnsureDirectory(DirectoryOf(to));
    return CopyFileW(from.c_str(), to.c_str(), FALSE) != FALSE;
}

bool ReadTextFile(const std::wstring& path, std::wstring& out)
{
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    std::string bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF &&
        static_cast<unsigned char>(bytes[1]) == 0xBB && static_cast<unsigned char>(bytes[2]) == 0xBF) {
        bytes.erase(0, 3);
    }
    out = Utf8ToWide(bytes);
    return true;
}

bool WriteTextFile(const std::wstring& path, const std::wstring& text)
{
    EnsureDirectory(DirectoryOf(path));
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) return false;
    const std::string bytes = WideToUtf8(text);
    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    return file.good();
}

bool ReadBinaryFile(const std::wstring& path, std::vector<uint8_t>& out)
{
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    out.assign((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    return true;
}

std::wstring FormatBytes(uint64_t bytes)
{
    const wchar_t* units[] = { L"B", L"KB", L"MB", L"GB" };
    double value = static_cast<double>(bytes);
    int unit = 0;
    while (value >= 1024.0 && unit < 3) { value /= 1024.0; ++unit; }
    wchar_t buffer[64] = {};
    swprintf_s(buffer, L"%.1f %s", value, units[unit]);
    return buffer;
}

std::wstring Utf8ToWide(const std::string& text)
{
    if (text.empty()) return std::wstring();
    const int length = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (length <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), length);
    return out;
}

std::string WideToUtf8(const std::wstring& text)
{
    if (text.empty()) return std::string();
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return std::string();
    std::string out(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), length, nullptr, nullptr);
    return out;
}

std::wstring QuoteArg(const std::wstring& arg)
{
    if (arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (wchar_t ch : arg) {
        if (ch == L'"') out += L'\\';
        out += ch;
    }
    out += L'"';
    return out;
}

bool RunProcessCapture(const std::wstring& exe, const std::vector<std::wstring>& args,
    const std::wstring& workingDir, DWORD& exitCode, std::wstring& output, std::wstring& error)
{
    output.clear();
    error.clear();
    exitCode = static_cast<DWORD>(-1);

    std::wstring command = QuoteArg(exe);
    for (const auto& arg : args) command += L" " + QuoteArg(arg);

    const std::wstring outPath = JoinPath(TempDirectory(), L"cepzh-process-" + std::to_wstring(GetCurrentProcessId()) + L".log");
    HANDLE file = CreateFileW(outPath.c_str(), GENERIC_WRITE | GENERIC_READ, FILE_SHARE_READ, nullptr,
        CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        error = L"无法创建进程日志";
        return false;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = file;
    si.hStdError = file;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    PROCESS_INFORMATION pi{};
    std::wstring mutableCommand = command;
    const BOOL ok = CreateProcessW(exe.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW, nullptr, workingDir.empty() ? nullptr : workingDir.c_str(), &si, &pi);
    if (!ok) {
        error = L"无法启动进程：" + exe;
        CloseHandle(file);
        DeleteFileW(outPath.c_str());
        return false;
    }

    WaitForSingleObject(pi.hProcess, 10 * 60 * 1000);
    GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    SetFilePointer(file, 0, nullptr, FILE_BEGIN);
    LARGE_INTEGER size{};
    GetFileSizeEx(file, &size);
    if (size.QuadPart > 0 && size.QuadPart < 1024 * 1024) {
        std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
        DWORD read = 0;
        ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr);
        bytes.resize(read);
        output = Utf8ToWide(bytes);
    }
    CloseHandle(file);
    DeleteFileW(outPath.c_str());
    return true;
}

std::wstring JsonEscape(const std::wstring& value)
{
    std::wstring out;
    for (wchar_t ch : value) {
        switch (ch) {
        case L'\\': out += L"\\\\"; break;
        case L'"': out += L"\\\""; break;
        case L'\n': out += L"\\n"; break;
        case L'\r': out += L"\\r"; break;
        case L'\t': out += L"\\t"; break;
        default: out += ch; break;
        }
    }
    return out;
}

bool PatchConfig(const std::wstring& file, const std::wstring& nodePath, const std::wstring& agentScript,
    std::wstring& error)
{
    std::wstring text;
    if (!ReadTextFile(file, text)) text.clear();
    if (text.empty()) {
        text = L"{\n"
               L"  \"nodePath\": \"" + JsonEscape(nodePath) + L"\",\n"
               L"  \"extraArgs\": [\"--verbose\"],\n"
               L"  \"agentScript\": \"" + JsonEscape(agentScript) + L"\"\n"
               L"}\n";
        return WriteTextFile(file, text);
    }

    const std::wstring nodeValue = L"\"" + JsonEscape(nodePath) + L"\"";
    const std::wstring agentValue = L"\"" + JsonEscape(agentScript) + L"\"";
    auto replaceKey = [&](const wchar_t* key, const std::wstring& value, bool& found) {
        const std::wregex re(std::wstring(L"\"") + key + L"\"\\s*:\\s*\"(?:\\\\.|[^\"])*\"");
        if (std::regex_search(text, re)) {
            text = std::regex_replace(text, re, std::wstring(L"\"") + key + L"\": " + value);
            found = true;
        }
    };
    bool foundNode = false;
    bool foundAgent = false;
    replaceKey(L"nodePath", nodeValue, foundNode);
    replaceKey(L"agentScript", agentValue, foundAgent);

    if (!foundNode || !foundAgent) {
        const size_t close = text.find_last_of(L'}');
        if (close == std::wstring::npos) {
            error = L"config.json 格式无效";
            return false;
        }
        std::wstring add;
        if (!foundNode) add += L"  \"nodePath\": " + nodeValue + L",\n";
        if (!foundAgent) add += L"  \"agentScript\": " + agentValue + L",\n";
        text.insert(close, add);
        text = std::regex_replace(text, std::wregex(L",\\s*}"), L"\n}");
    }
    return WriteTextFile(file, text);
}
