#include "installer.h"

#include "util.h"

#include "miniz.h"

#include <windows.h>
#include <winver.h>
#include <tlhelp32.h>
#include <winhttp.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <bcrypt.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <sstream>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace fs = std::filesystem;

namespace
{
void Trace(const std::wstring& message)
{
    std::ofstream file(WideToUtf8(JoinPath(TempDirectory(), L"CEP-ZH-installer.log")),
        std::ios::binary | std::ios::app);
    if (!file) return;
    const std::string line = WideToUtf8(message) + "\r\n";
    file.write(line.data(), static_cast<std::streamsize>(line.size()));
}

const wchar_t* kNodeUrls[] = {
    L"https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-win-x64.zip",
    L"https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.14.0/node-v22.14.0-win-x64.zip",
    L"https://mirrors.aliyun.com/nodejs-release/v22.14.0/node-v22.14.0-win-x64.zip",
    L"https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip",
};
const wchar_t* kNodeLabels[] = { L"npmmirror", L"清华镜像", L"阿里云镜像", L"Node.js 官方" };
constexpr wchar_t kNodeSha256[] = L"55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217";
constexpr wchar_t kHosts[] = L"AEFT,PHXS,PPRO,ILST,IDSN,FLPR,AUDT,DRWV";
const wchar_t* kRepoUrls[] = {
    L"https://ghfast.top/https://github.com/Three-LEI/CEP-ZH/releases/download/v0.2.6/CEP-ZH-runtime-v0.2.6.zip",
    L"https://gh-proxy.com/https://github.com/Three-LEI/CEP-ZH/releases/download/v0.2.6/CEP-ZH-runtime-v0.2.6.zip",
    L"https://ghproxy.net/https://github.com/Three-LEI/CEP-ZH/releases/download/v0.2.6/CEP-ZH-runtime-v0.2.6.zip",
    L"https://ghproxy.imciel.com/https://github.com/Three-LEI/CEP-ZH/releases/download/v0.2.6/CEP-ZH-runtime-v0.2.6.zip",
    L"https://github.com/Three-LEI/CEP-ZH/releases/download/v0.2.6/CEP-ZH-runtime-v0.2.6.zip",
};
const wchar_t* kRepoLabels[] = {
    L"ghfast.top", L"gh-proxy.com", L"ghproxy.net", L"ghproxy.imciel.com", L"GitHub 直连",
};
constexpr wchar_t kSourceSha256[] = L"546c6eaf6736722dbff32f212821c8b9e8a629b9c226b2958fd164b92c783e05";

bool ParseHttpUrl(const std::wstring& url, std::wstring& host, std::wstring& path, INTERNET_PORT& port, bool& secure)
{
    secure = url.rfind(L"https://", 0) == 0;
    const std::wstring prefix = secure ? L"https://" : L"http://";
    if (url.rfind(prefix, 0) != 0) return false;
    std::wstring rest = url.substr(prefix.size());
    const size_t slash = rest.find(L'/');
    std::wstring authority = slash == std::wstring::npos ? rest : rest.substr(0, slash);
    path = slash == std::wstring::npos ? L"/" : rest.substr(slash);
    port = secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
    const size_t colon = authority.find(L':');
    if (colon != std::wstring::npos) {
        host = authority.substr(0, colon);
        port = static_cast<INTERNET_PORT>(_wtoi(authority.substr(colon + 1).c_str()));
    } else {
        host = authority;
    }
    return !host.empty();
}

bool Sha256File(const std::wstring& path, std::wstring& hex, std::wstring& error)
{
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectSize = 0;
    DWORD hashSize = 0;
    DWORD resultSize = 0;
    NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (status < 0) { error = L"SHA-256 初始化失败"; return false; }
    status = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &resultSize, 0);
    if (status < 0) { BCryptCloseAlgorithmProvider(algorithm, 0); error = L"SHA-256 参数失败"; return false; }
    status = BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
        reinterpret_cast<PUCHAR>(&hashSize), sizeof(hashSize), &resultSize, 0);
    if (status < 0) { BCryptCloseAlgorithmProvider(algorithm, 0); error = L"SHA-256 参数失败"; return false; }

    std::vector<BYTE> object(objectSize);
    std::vector<BYTE> digest(hashSize);
    status = BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0);
    if (status < 0) { BCryptCloseAlgorithmProvider(algorithm, 0); error = L"SHA-256 创建失败"; return false; }

    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        BCryptDestroyHash(hash);
        BCryptCloseAlgorithmProvider(algorithm, 0);
        error = L"无法读取下载文件";
        return false;
    }

    bool ok = true;
    std::vector<BYTE> buffer(1024 * 1024);
    for (;;) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            ok = false;
            error = L"读取下载文件失败";
            break;
        }
        if (!read) break;
        status = BCryptHashData(hash, buffer.data(), read, 0);
        if (status < 0) {
            ok = false;
            error = L"SHA-256 计算失败";
            break;
        }
    }
    CloseHandle(file);
    if (ok) {
        status = BCryptFinishHash(hash, digest.data(), hashSize, 0);
        if (status < 0) { ok = false; error = L"SHA-256 完成失败"; }
    }
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!ok) return false;

    static const wchar_t* digits = L"0123456789abcdef";
    hex.clear();
    hex.reserve(hashSize * 2);
    for (BYTE byte : digest) {
        hex.push_back(digits[byte >> 4]);
        hex.push_back(digits[byte & 0x0f]);
    }
    return true;
}

bool HttpDownload(const std::wstring& url, const std::wstring& outPath,
    const std::function<void(uint64_t, uint64_t)>& progress, std::wstring& error)
{
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port = 0;
    bool secure = false;
    if (!ParseHttpUrl(url, host, path, port, secure)) {
        error = L"URL 无效：" + url;
        return false;
    }

    HINTERNET session = WinHttpOpen(L"CEP-ZH-Installer/0.2", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { error = L"WinHTTP 初始化失败"; return false; }
    WinHttpSetTimeouts(session, 15000, 15000, 30000, 30000);

    HINTERNET connection = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connection) { WinHttpCloseHandle(session); error = L"无法连接：" + host; return false; }

    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
    if (!request) {
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        error = L"无法创建 HTTP 请求";
        return false;
    }

    DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));

    if (secure) {
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_1 |
                          WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        WinHttpSetOption(request, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    }

    BOOL ok = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
    if (ok) ok = WinHttpReceiveResponse(request, nullptr);
    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    if (ok) ok = WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (!ok || status != 200) {
        error = L"HTTP " + std::to_wstring(status) + L"：" + url;
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }

    DWORD length = 0;
    DWORD lengthSize = sizeof(length);
    WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &length, &lengthSize, WINHTTP_NO_HEADER_INDEX);
    const uint64_t total = static_cast<uint64_t>(length);

    EnsureDirectory(DirectoryOf(outPath));
    HANDLE file = CreateFileW(outPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        error = L"无法写入：" + outPath;
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }

    uint64_t done = 0;
    bool success = true;
    for (;;) {
        if (total && done >= total) break;
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available) || available == 0) break;
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &read) || read == 0) break;
        DWORD written = 0;
        if (!WriteFile(file, buffer.data(), read, &written, nullptr) || written != read) {
            success = false;
            error = L"写入下载文件失败";
            break;
        }
        done += read;
        if (progress) progress(done, total);
    }
    CloseHandle(file);

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);

    if (!success) {
        DeleteFileW(outPath.c_str());
        return false;
    }
    if (total && done != total) {
        error = L"下载不完整：" + FormatBytes(done) + L" / " + FormatBytes(total);
        DeleteFileW(outPath.c_str());
        return false;
    }
    return true;
}

bool ShouldExtract(const std::string& name)
{
    std::string normalized = name;
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    // Pinned runtime archives are flat: product/... starts at the ZIP root.
    // Existing GitHub archives are nested: CEP-ZH-main/product/...
    // Normalize both forms to a leading slash before matching.
    if (normalized.empty() || normalized.front() != '/') normalized.insert(normalized.begin(), '/');
    return normalized.find("/product/cep.zh.manager/") != std::string::npos ||
           normalized.find("/tools/cep-zh/") != std::string::npos ||
           normalized.find("/tools/elevate/dist/") != std::string::npos ||
           normalized.find("/tools/bootstrap/dist/VCRUNTIME140_1.dll") != std::string::npos;
}

bool ExtractZip(const std::wstring& zipPath, const std::wstring& dest, bool onlyCep,
    const std::function<void(int, int)>& progress, std::wstring& error)
{
    mz_zip_archive zip{};
    if (!mz_zip_reader_init_file(&zip, WideToUtf8(zipPath).c_str(), 0)) {
        error = L"无法读取 ZIP：" + zipPath;
        return false;
    }
    const mz_uint total = mz_zip_reader_get_num_files(&zip);
    mz_uint extracted = 0;
    for (mz_uint i = 0; i < total; ++i) {
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&zip, i, &stat)) continue;
        if (stat.m_is_directory) continue;
        const std::string name(stat.m_filename);
        if (onlyCep && !ShouldExtract(name)) continue;
        if (name.find("..") != std::string::npos || name.find(':') != std::string::npos) continue;
        bool ascii = true;
        for (char ch : name) {
            if (static_cast<unsigned char>(ch) >= 0x80) { ascii = false; break; }
        }
        if (!ascii) continue;
        std::wstring relative(name.begin(), name.end());
        std::replace(relative.begin(), relative.end(), L'/', L'\\');
        const std::wstring target = JoinPath(dest, relative);
        if (!EnsureDirectory(DirectoryOf(target))) continue;
        if (!mz_zip_reader_extract_to_file(&zip, i, WideToUtf8(target).c_str(), 0)) {
            continue;
        }
        ++extracted;
        if (progress) progress(static_cast<int>(extracted), static_cast<int>(total));
    }
    mz_zip_reader_end(&zip);
    if (!extracted) {
        error = onlyCep ? L"ZIP 中没有 CEP-ZH 文件" : L"ZIP 中没有可解压文件";
        return false;
    }
    return true;
}

std::wstring FindRepoRoot(const std::wstring& extracted)
{
    // The pinned runtime archive is intentionally packaged with product/ and
    // tools/ at the ZIP root, so also accept the extraction directory itself.
    if (DirectoryExists(JoinPath(extracted, L"product\\cep.zh.manager"))) return extracted;
    std::error_code ec;
    for (fs::recursive_directory_iterator it(fs::path(extracted), ec), end; it != end && !ec; it.increment(ec)) {
        if (ec) break;
        if (it.depth() > 3) { it.disable_recursion_pending(); continue; }
        if (it->is_directory()) {
            const fs::path probe = it->path() / L"product" / L"cep.zh.manager";
            if (DirectoryExists(probe.wstring())) return it->path().wstring();
        }
    }
    return std::wstring();
}

std::wstring FindNodeInTree(const std::wstring& root)
{
    std::error_code ec;
    const fs::path direct = fs::path(root) / L"node.exe";
    if (FileExists(direct.wstring())) return direct.wstring();
    for (fs::recursive_directory_iterator it(fs::path(root), ec), end; it != end && !ec; it.increment(ec)) {
        if (ec) break;
        if (it.depth() > 3) { it.disable_recursion_pending(); continue; }
        if (it->is_regular_file() && _wcsicmp(it->path().filename().c_str(), L"node.exe") == 0)
            return it->path().wstring();
    }
    return std::wstring();
}

std::wstring FindSystemNode()
{
    wchar_t found[MAX_PATH * 2] = {};
    if (SearchPathW(nullptr, L"node.exe", nullptr, static_cast<DWORD>(std::size(found)), found, nullptr))
        return found;
    const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
    const std::vector<std::wstring> candidates = {
        L"C:\\Program Files\\nodejs\\node.exe",
        JoinPath(local, L"Programs\\nodejs\\node.exe"),
        JoinPath(local, L"CEP-ZH\\node\\node.exe"),
    };
    for (const auto& path : candidates) if (FileExists(path)) return path;
    const std::wstring downloaded = JoinPath(local, L"CEP-ZH\\node");
    if (DirectoryExists(downloaded)) {
        const std::wstring node = FindNodeInTree(downloaded);
        if (!node.empty()) return node;
    }
    return std::wstring();
}

std::wstring EnvPath(const wchar_t* name)
{
    wchar_t buffer[MAX_PATH * 2] = {};
    const DWORD len = GetEnvironmentVariableW(name, buffer, static_cast<DWORD>(std::size(buffer)));
    return len ? std::wstring(buffer, len) : std::wstring();
}

void CountExtensions(const std::wstring& root, int& total, int& withDebug)
{
    std::error_code ec;
    if (!DirectoryExists(root)) return;
    for (fs::directory_iterator it(fs::path(root), ec), end; it != end && !ec; it.increment(ec)) {
        if (ec) break;
        if (!it->is_directory()) continue;
        const fs::path manifest = it->path() / L"CSXS" / L"manifest.xml";
        if (!FileExists(manifest.wstring())) continue;
        ++total;
        if (FileExists((it->path() / L".debug").wstring())) ++withDebug;
    }
}

bool InstallFiles(const std::wstring& repoRoot, const std::wstring& nodePath, std::wstring& error)
{
    const std::wstring sourceExt = JoinPath(JoinPath(repoRoot, L"product"), L"cep.zh.manager");
    const std::wstring sourceAgent = JoinPath(JoinPath(repoRoot, L"tools"), L"cep-zh");
    const std::wstring sourceElevate = JoinPath(JoinPath(JoinPath(repoRoot, L"tools"), L"elevate\\dist"), L"cepzh-elevate.exe");
    if (!DirectoryExists(sourceExt) || !DirectoryExists(sourceAgent)) {
        error = L"下载包内容不完整";
        return false;
    }
    if (!FileExists(sourceElevate)) {
        error = L"下载包缺少 CEP汉化修复工具.exe";
        return false;
    }

    const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
    const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
    const std::wstring extTarget = JoinPath(roaming, L"Adobe\\CEP\\extensions\\cep.zh.manager");
    const std::wstring agentRoot = JoinPath(local, L"CEP-ZH\\agent");
    const std::wstring agentTools = JoinPath(agentRoot, L"tools\\cep-zh");
    const std::wstring configDir = JoinPath(roaming, L"CEP-ZH");
    const std::wstring configPath = JoinPath(configDir, L"config.json");
    const std::wstring agentScript = JoinPath(agentTools, L"agent.mjs");
    const std::wstring fontCache = JoinPath(local, L"CEP-ZH\\font-cache");

    // Preserve locally installed MiSans files across upgrades. The public
    // source archive intentionally does not contain the WOFF2 binaries.
    const std::wstring oldFonts = JoinPath(extTarget, L"fonts");
    if (DirectoryExists(oldFonts)) {
        RemoveTree(fontCache);
        CopyTree(oldFonts, fontCache);
    }

    // Keep the old extension once, so a failed upgrade can be rolled back.
    if (DirectoryExists(extTarget)) {
        const std::wstring backup = extTarget + L".cepzh-backup";
        if (!DirectoryExists(backup)) CopyTree(extTarget, backup);
        if (!RemoveTree(extTarget)) { error = L"无法替换旧扩展目录"; return false; }
    }
    if (!CopyTree(sourceExt, extTarget)) { error = L"复制管理面板失败"; return false; }
    if (!DirectoryExists(JoinPath(extTarget, L"fonts")) && DirectoryExists(fontCache))
        CopyTree(fontCache, JoinPath(extTarget, L"fonts"));

    if (!RemoveTree(agentTools) && DirectoryExists(agentTools)) { error = L"无法更新 Agent 目录"; return false; }
    if (!EnsureDirectory(agentTools)) { error = L"无法创建 Agent 目录"; return false; }
    if (!CopyTree(sourceAgent, agentTools)) { error = L"复制 Agent 失败"; return false; }

    const std::wstring elevateBin = JoinPath(agentRoot, L"bin");
    if (!EnsureDirectory(elevateBin)) { error = L"无法创建提权工具目录"; return false; }
    const std::wstring elevateTarget = JoinPath(elevateBin, L"CEP汉化修复工具.exe");
    if (!CopyFileW(sourceElevate.c_str(), elevateTarget.c_str(), FALSE)) {
        error = L"复制 CEP汉化修复工具.exe 失败";
        return false;
    }

    if (!EnsureDirectory(configDir)) { error = L"无法创建配置目录"; return false; }
    if (!PatchConfig(configPath, nodePath, agentScript, error)) return false;
    return true;
}

std::wstring TailLines(const std::wstring& text, int count)
{
    std::wstring out;
    std::wstringstream stream(text);
    std::wstring line;
    std::vector<std::wstring> lines;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        if (!line.empty()) lines.push_back(line);
    }
    const int start = std::max(0, static_cast<int>(lines.size()) - count);
    for (int i = start; i < static_cast<int>(lines.size()); ++i) {
        if (!out.empty()) out += L"\n";
        out += lines[i];
    }
    return out;
}

int EngineMajor(const std::wstring& exe)
{
    DWORD size = GetFileVersionInfoSizeW(exe.c_str(), nullptr);
    if (!size) return 0;
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(exe.c_str(), 0, size, data.data())) return 0;
    VS_FIXEDFILEINFO* info = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &length) || !info)
        return 0;
    return static_cast<int>(HIWORD(info->dwFileVersionMS));
}

bool IsOurProxy(const std::wstring& path)
{
    std::vector<uint8_t> bytes;
    if (!ReadBinaryFile(path, bytes)) return false;
    const std::string text(bytes.begin(), bytes.end());
    return text.find("cep-zh CEP engine proxy") != std::string::npos;
}

bool AdobeAppRunning()
{
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    const wchar_t* names[] = {
        L"AfterFX.exe", L"Photoshop.exe", L"Illustrator.exe",
        L"Adobe Premiere Pro.exe", L"InDesign.exe", L"Animate.exe",
    };
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    bool found = false;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            for (const wchar_t* name : names) {
                if (_wcsicmp(entry.szExeFile, name) == 0) { found = true; break; }
            }
            if (found) break;
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return found;
}

std::vector<std::wstring> CepEngineDirs()
{
    const std::vector<std::wstring> roots = {
        L"D:\\Adobe",
        L"C:\\Program Files\\Adobe",
        L"C:\\Program Files (x86)\\Adobe",
    };
    std::vector<std::wstring> dirs;
    std::error_code ec;
    for (const auto& root : roots) {
        if (!DirectoryExists(root)) continue;
        for (fs::recursive_directory_iterator it(fs::path(root), ec), end; it != end && !ec; it.increment(ec)) {
            if (ec) break;
            if (!it->is_regular_file()) continue;
            if (_wcsicmp(it->path().filename().c_str(), L"CEPHtmlEngine.exe") == 0)
                dirs.push_back(it->path().parent_path().wstring());
        }
        ec.clear();
    }
    std::sort(dirs.begin(), dirs.end());
    dirs.erase(std::unique(dirs.begin(), dirs.end()), dirs.end());
    return dirs;
}

int InstallEngineProxy(const std::wstring& repoRoot, std::deque<std::wstring>& logs)
{
    const std::wstring source = JoinPath(JoinPath(JoinPath(JoinPath(repoRoot, L"tools"), L"bootstrap"), L"dist"),
        L"VCRUNTIME140_1.dll");
    if (!FileExists(source)) {
        logs.push_back(L"未找到 CEP12 引擎代理，跳过全局代理");
        return 0;
    }
    if (AdobeAppRunning()) {
        logs.push_back(L"检测到 Adobe 应用正在运行，暂不替换引擎代理；关闭应用后重试");
        return 0;
    }

    int installed = 0;
    for (const auto& dir : CepEngineDirs()) {
        const std::wstring engine = JoinPath(dir, L"CEPHtmlEngine.exe");
        if (EngineMajor(engine) < 12) continue;
        const std::wstring target = JoinPath(dir, L"VCRUNTIME140_1.dll");
        const std::wstring backup = target + L".cepzh-orig";
        if (FileExists(target) && !IsOurProxy(target) && !FileExists(backup))
            CopyFileSimple(target, backup);
        if (CopyFileSimple(source, target)) ++installed;
    }
    if (installed)
        logs.push_back(L"CEP12 引擎代理已安装：" + std::to_wstring(installed) + L" 个（后续新插件自动生效）");
    else
        logs.push_back(L"没有可安装代理的 CEP12 引擎");
    return installed;
}

int RestoreEngineProxy(std::deque<std::wstring>& logs)
{
    int restored = 0;
    for (const auto& dir : CepEngineDirs()) {
        const std::wstring target = JoinPath(dir, L"VCRUNTIME140_1.dll");
        const std::wstring backup = target + L".cepzh-orig";
        if (FileExists(backup)) {
            if (CopyFileSimple(backup, target)) {
                DeleteFileW(backup.c_str());
                ++restored;
            }
        } else if (IsOurProxy(target)) {
            if (DeleteFileW(target.c_str())) ++restored;
        }
    }
    if (restored) logs.push_back(L"CEP12 引擎代理已恢复：" + std::to_wstring(restored) + L" 个");
    return restored;
}

std::wstring InstalledExePath()
{
    return JoinPath(KnownFolder(FOLDERID_LocalAppData), L"CEP-ZH\\CepZhInstaller.exe");
}

std::wstring ShortcutPath()
{
    return JoinPath(KnownFolder(FOLDERID_Desktop), L"CEP 汉化管理器.lnk");
}

bool CreateDesktopShortcut(std::wstring& error)
{
    const std::wstring exe = InstalledExePath();
    if (!FileExists(exe)) {
        error = L"找不到已复制的安装器";
        return false;
    }

    const HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool comInitialized = SUCCEEDED(init);
    if (!comInitialized && init != RPC_E_CHANGED_MODE) {
        error = L"COM 初始化失败";
        return false;
    }

    IShellLinkW* link = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&link));
    if (FAILED(hr) || !link) {
        error = L"无法创建快捷方式";
        if (comInitialized) CoUninitialize();
        return false;
    }

    link->SetPath(exe.c_str());
    link->SetWorkingDirectory(DirectoryOf(exe).c_str());
    link->SetDescription(L"CEP 汉化管理器安装器");
    link->SetIconLocation(exe.c_str(), 0);

    IPersistFile* persist = nullptr;
    hr = link->QueryInterface(IID_PPV_ARGS(&persist));
    if (SUCCEEDED(hr) && persist) {
        hr = persist->Save(ShortcutPath().c_str(), TRUE);
        persist->Release();
    }
    link->Release();
    if (comInitialized) CoUninitialize();
    if (FAILED(hr)) {
        error = L"保存桌面快捷方式失败";
        return false;
    }
    return true;
}

bool InstallShortcutForSelf(std::deque<std::wstring>& log, std::wstring& error)
{
    const std::wstring self = ModulePath();
    const std::wstring target = InstalledExePath();
    if (_wcsicmp(self.c_str(), target.c_str()) != 0) {
        if (!CopyFileSimple(self, target)) {
            error = L"复制安装器到本地目录失败";
            return false;
        }
    }
    if (!CreateDesktopShortcut(error)) return false;
    log.push_back(L"桌面快捷方式：" + ShortcutPath());
    return true;
}
} // namespace

bool RunInstaller(const UiPublish& publish)
{
    std::wstring step1 = L"等待";
    std::wstring step2 = L"等待";
    std::deque<std::wstring> logs;
    std::wstring status = L"检查 Node.js 运行时";
    int progress = 0;
    bool busy = true;
    bool done = false;
    bool failed = false;
    std::wstring error;

    auto apply = [&]() {
        // The UI update is posted asynchronously. Capture a snapshot by value:
        // the worker's locals are destroyed when RunInstaller returns.
        UiModel snapshot;
        snapshot.progress = progress;
        snapshot.busy = busy;
        snapshot.done = done;
        snapshot.failed = failed;
        snapshot.status = status;
        snapshot.step1 = step1;
        snapshot.step2 = step2;
        snapshot.error = error;
        snapshot.log = logs;
        publish([snapshot](UiModel& model) { model = snapshot; });
    };
    auto log = [&](const std::wstring& line) {
        if (line.empty()) return;
        logs.push_back(line);
        while (logs.size() > 4) logs.pop_front();
    };
    auto fail = [&](const std::wstring& message) {
        error = message;
        failed = true;
        busy = false;
        status = message;
        log(L"ERROR: " + message);
        Trace(L"FAIL: " + message);
        apply();
        return false;
    };

    Trace(L"BEGIN");
    apply();

    const std::wstring tempRoot = JoinPath(TempDirectory(),
        L"CEP-ZH-installer-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(GetTickCount64()));
    if (!EnsureDirectory(tempRoot)) return fail(L"无法创建临时目录");

    // 1. Node runtime ---------------------------------------------------------
    std::wstring node = FindSystemNode();
    if (node.empty()) {
        step1 = L"下载 Node.js 运行时";
        status = L"未检测到 Node.js，正在下载便携运行时…";
        log(L"未检测到 Node.js 18+，下载 Node.js 22.14.0");
        apply();

        const std::wstring nodeZip = JoinPath(tempRoot, L"node.zip");
        std::wstring downloadError;
        auto nodeProgress = [&](uint64_t got, uint64_t total) {
            const int p = total ? static_cast<int>((got * 30) / total) : 0;
            if (p == progress) return;
            progress = p;
            status = L"下载 Node.js 运行时  " + FormatBytes(got) +
                     (total ? L" / " + FormatBytes(total) : L"");
            apply();
        };
        bool nodeDownloaded = false;
        for (size_t i = 0; i < std::size(kNodeUrls); ++i) {
            status = std::wstring(L"下载 Node.js · ") + kNodeLabels[i];
            apply();
            if (HttpDownload(kNodeUrls[i], nodeZip, nodeProgress, downloadError)) {
                std::wstring actualHash;
                std::wstring hashError;
                if (Sha256File(nodeZip, actualHash, hashError)
                    && _wcsicmp(actualHash.c_str(), kNodeSha256) == 0) {
                    nodeDownloaded = true;
                    break;
                }
                log(L"Node 校验失败：" + (hashError.empty() ? actualHash : hashError));
                DeleteFileW(nodeZip.c_str());
            } else {
                log(std::wstring(L"Node 源失败 ") + kNodeLabels[i] + L"：" + downloadError);
                DeleteFileW(nodeZip.c_str());
            }
        }
        if (!nodeDownloaded) return fail(L"下载或校验 Node.js 失败：" + downloadError);

        const std::wstring nodeRoot = JoinPath(KnownFolder(FOLDERID_LocalAppData), L"CEP-ZH\\node");
        RemoveTree(nodeRoot);
        if (!EnsureDirectory(nodeRoot)) return fail(L"无法创建 Node 目录");
        step1 = L"解压 Node.js 运行时";
        status = L"正在解压 Node.js…";
        apply();
        if (!ExtractZip(nodeZip, nodeRoot, false, nullptr, downloadError))
            return fail(L"解压 Node.js 失败：" + downloadError);
        node = FindNodeInTree(nodeRoot);
        if (node.empty()) return fail(L"解压后没有找到 node.exe");
        log(L"Node.js: " + node);
    } else {
        log(L"Node.js: " + node);
    }
    progress = std::max(progress, 30);
    step1 = L"下载 CEP 汉化文件";
    status = L"下载固定版本 CEP-ZH 运行时并校验 SHA-256…";
    apply();

    // 2. Download pinned runtime archive -------------------------------------
    const std::wstring repoZip = JoinPath(tempRoot, L"repo.zip");
    std::wstring downloadError;
    auto repoProgress = [&](uint64_t got, uint64_t total) {
        const int p = 30 + (total ? static_cast<int>((got * 35) / total) : 0);
        if (p == progress) return;
        progress = p;
        status = L"下载 CEP-ZH  " + FormatBytes(got) +
                 (total ? L" / " + FormatBytes(total) : L"");
        apply();
    };
    bool downloaded = false;
    for (size_t i = 0; i < std::size(kRepoUrls); ++i) {
        status = std::wstring(L"下载 CEP-ZH · ") + kRepoLabels[i];
        log(status);
        apply();
        downloadError.clear();
        if (!HttpDownload(kRepoUrls[i], repoZip, repoProgress, downloadError)) {
            log(L"下载源失败：" + downloadError);
            DeleteFileW(repoZip.c_str());
            continue;
        }
        std::wstring actualHash;
        std::wstring hashError;
        if (!Sha256File(repoZip, actualHash, hashError)) {
            log(L"SHA-256 读取失败：" + hashError);
            DeleteFileW(repoZip.c_str());
            continue;
        }
        if (_wcsicmp(actualHash.c_str(), kSourceSha256) != 0) {
            log(L"下载源 SHA-256 不匹配：" + actualHash);
            DeleteFileW(repoZip.c_str());
            continue;
        }
        downloaded = true;
        break;
    }
    if (!downloaded)
        return fail(L"下载或校验 CEP-ZH 运行时失败：" + downloadError);
    Trace(L"DOWNLOADED");

    // 3. Extract -------------------------------------------------------------
    step1 = L"解压 CEP 汉化文件";
    status = L"正在解压管理器与 Agent…";
    apply();
    const std::wstring extracted = JoinPath(tempRoot, L"extracted");
    if (!EnsureDirectory(extracted)) return fail(L"无法创建解压目录");
    if (!ExtractZip(repoZip, extracted, true, nullptr, downloadError))
        return fail(L"解压 CEP-ZH 失败：" + downloadError);
    const std::wstring repoRoot = FindRepoRoot(extracted);
    if (repoRoot.empty()) return fail(L"压缩包中没有 product/cep.zh.manager");
    progress = 75;
    apply();

    // 4. Install files -------------------------------------------------------
    step1 = L"安装管理器与 Agent";
    status = L"写入 CEP 扩展与 Agent 文件…";
    apply();
    if (!InstallFiles(repoRoot, node, error)) return fail(error);
    Trace(L"INSTALLED");

    step1 = L"安装 CEP12 引擎代理";
    status = L"为 CEP12 引擎安装全局调试代理（新插件自动生效）…";
    progress = 82;
    apply();
    InstallEngineProxy(repoRoot, logs);
    step1 = L"完成";
    progress = 84;
    apply();

    // 5. Initialize .debug ---------------------------------------------------
    step2 = L"检测 CEP 扩展";
    status = L"扫描已安装的 CEP 扩展…";
    apply();

    const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
    const std::wstring common = EnvPath(L"CommonProgramFiles");
    const std::wstring commonX86 = EnvPath(L"CommonProgramFiles(x86)");
    int total = 0;
    int withDebug = 0;
    CountExtensions(JoinPath(roaming, L"Adobe\\CEP\\extensions"), total, withDebug);
    CountExtensions(JoinPath(common, L"Adobe\\CEP\\extensions"), total, withDebug);
    CountExtensions(JoinPath(commonX86, L"Adobe\\CEP\\extensions"), total, withDebug);
    step2 = L"发现 " + std::to_wstring(total) + L" 个扩展，已有 .debug " + std::to_wstring(withDebug);
    log(step2);
    progress = 88;
    apply();

    step2 = L"写入 .debug";
    status = L"检测已有 .debug；缺失的扩展自动生成端口…";
    apply();

    const std::wstring agentTools = JoinPath(
        JoinPath(KnownFolder(FOLDERID_LocalAppData), L"CEP-ZH\\agent\\tools\\cep-zh"), L"");
    const std::wstring cli = JoinPath(agentTools, L"cli.mjs");
    if (!FileExists(cli)) return fail(L"找不到 CLI：" + cli);

    DWORD exitCode = 0;
    std::wstring output;
    std::wstring processError;
    bool debugWarning = false;
    const bool skipDebug = GetEnvironmentVariableW(L"CEPZH_SKIP_DEBUG", nullptr, 0) > 0;
    if (skipDebug) {
        Trace(L"SKIP_DEBUG");
    } else if (!RunProcessCapture(node, { cli, L"enable", L"--hosts", kHosts }, agentTools, exitCode,
            output, processError)) {
        return fail(L"启动 .debug 初始化失败：" + processError);
    } else {
        const std::wstring tail = TailLines(output, 3);
        if (!tail.empty()) log(tail);
        if (exitCode != 0) {
            debugWarning = true;
            log(L"部分 .debug 未写入（退出码 " + std::to_wstring(exitCode) + L"），可稍后重试");
        }
    }
    {
        DWORD baselineCode = 0;
        std::wstring baselineOut;
        std::wstring baselineErr;
        if (RunProcessCapture(node, { cli, L"baseline" }, agentTools, baselineCode, baselineOut, baselineErr)) {
            const std::wstring baselineTail = TailLines(baselineOut, 1);
            if (!baselineTail.empty()) log(baselineTail);
        }
    }
    Trace(L"DEBUG_DONE");

    step2 = debugWarning ? L"完成（部分跳过）" : L"完成";
    progress = 100;
    busy = false;
    done = true;
    status = debugWarning
        ? L"安装完成；部分 .debug 未写入，可再次点击“开始安装”重试"
        : L"安装完成，请重启 Adobe 应用";
    if (!InstallShortcutForSelf(logs, error)) {
        log(L"警告：桌面快捷方式创建失败：" + error);
    }
    apply();

    Trace(L"CLEANUP_BEGIN");
    const bool keepTemp = GetEnvironmentVariableW(L"CEPZH_KEEP_TEMP", nullptr, 0) > 0;
    if (!keepTemp) RemoveTree(tempRoot);
    Trace(L"CLEANUP_DONE");
    return true;
}

bool RunUninstall(const UiPublish& publish)
{
    std::wstring step1 = L"移除管理器与 Agent";
    std::wstring step2 = L"恢复 .debug";
    std::deque<std::wstring> logs;
    std::wstring status = L"正在扫描已安装文件…";
    int progress = 5;
    bool busy = true;
    bool done = false;
    bool failed = false;
    std::wstring error;

    auto apply = [&]() {
        UiModel snapshot;
        snapshot.progress = progress;
        snapshot.busy = busy;
        snapshot.done = done;
        snapshot.failed = failed;
        snapshot.status = status;
        snapshot.step1 = step1;
        snapshot.step2 = step2;
        snapshot.error = error;
        snapshot.log = logs;
        publish([snapshot](UiModel& model) { model = snapshot; });
    };
    auto log = [&](const std::wstring& line) {
        if (line.empty()) return;
        logs.push_back(line);
        while (logs.size() > 4) logs.pop_front();
    };

    Trace(L"UNINSTALL_BEGIN");
    apply();

    const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
    const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
    const std::wstring extTarget = JoinPath(roaming, L"Adobe\\CEP\\extensions\\cep.zh.manager");
    const std::wstring agentRoot = JoinPath(local, L"CEP-ZH\\agent");
    const std::wstring agentTools = JoinPath(agentRoot, L"tools\\cep-zh");
    const std::wstring cli = JoinPath(agentTools, L"cli.mjs");

    // Restore/remove generated .debug files before the Agent disappears.
    const std::wstring node = FindSystemNode();
    if (node.empty()) {
        log(L"未找到 Node.js，跳过 .debug 还原");
    } else if (!FileExists(cli)) {
        log(L"未找到 CLI，跳过 .debug 还原");
    } else {
        DWORD exitCode = 0;
        std::wstring output;
        std::wstring processError;
        step2 = L"正在还原 .debug";
        apply();
        if (RunProcessCapture(node, { cli, L"disable" }, agentTools, exitCode, output, processError)) {
            const std::wstring tail = TailLines(output, 2);
            if (!tail.empty()) log(tail);
            if (exitCode != 0) log(L".debug 还原返回 " + std::to_wstring(exitCode));
        } else {
            log(L".debug 还原失败：" + processError);
        }
    }

    progress = 45;
    step2 = L"完成";
    status = L"移除扩展、Agent 与快捷方式…";
    apply();

    RestoreEngineProxy(logs);
    if (!RemoveTree(extTarget)) log(L"警告：扩展目录未完全删除");
    if (!RemoveTree(extTarget + L".cepzh-backup")) log(L"警告：扩展备份未完全删除");
    if (!RemoveTree(agentRoot)) log(L"警告：Agent 目录未完全删除");
    RemoveTree(JoinPath(local, L"CEP-ZH\\node"));
    RemoveTree(JoinPath(local, L"CEP-ZH\\font-cache"));

    const std::wstring shortcut = ShortcutPath();
    DeleteFileW(shortcut.c_str());
    const std::wstring installedExe = InstalledExePath();
    if (_wcsicmp(ModulePath().c_str(), installedExe.c_str()) == 0) {
        MoveFileExW(installedExe.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
    } else {
        DeleteFileW(installedExe.c_str());
    }

    step1 = L"完成";
    progress = 100;
    busy = false;
    done = true;
    status = L"卸载完成；字典和配置保留在 %APPDATA%\\CEP-ZH";
    log(L"已移除管理器、Agent 与桌面快捷方式");
    log(L"字典、AI 配置和 .debug 备份信息仍保留");
    Trace(L"UNINSTALL_DONE");
    apply();
    return true;
}
