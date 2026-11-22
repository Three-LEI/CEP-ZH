#pragma once

#include <windows.h>
#include <shlobj.h>

#include <cstdint>
#include <string>
#include <vector>

std::wstring JoinPath(const std::wstring& a, const std::wstring& b);
std::wstring KnownFolder(REFKNOWNFOLDERID id);
std::wstring TempDirectory();
std::wstring ExeDirectory();
std::wstring ModulePath();
std::wstring FileNameOf(const std::wstring& path);
std::wstring DirectoryOf(const std::wstring& path);

bool FileExists(const std::wstring& path);
bool DirectoryExists(const std::wstring& path);
bool EnsureDirectory(const std::wstring& path);
bool RemoveTree(const std::wstring& path);
bool CopyTree(const std::wstring& from, const std::wstring& to);
bool CopyFileSimple(const std::wstring& from, const std::wstring& to);

bool ReadTextFile(const std::wstring& path, std::wstring& out);
bool WriteTextFile(const std::wstring& path, const std::wstring& text);
bool ReadBinaryFile(const std::wstring& path, std::vector<uint8_t>& out);
std::wstring FormatBytes(uint64_t bytes);

std::wstring Utf8ToWide(const std::string& text);
std::string WideToUtf8(const std::wstring& text);
std::wstring QuoteArg(const std::wstring& arg);

bool RunProcessCapture(const std::wstring& exe, const std::vector<std::wstring>& args,
    const std::wstring& workingDir, DWORD& exitCode, std::wstring& output, std::wstring& error);

std::wstring JsonEscape(const std::wstring& value);
bool PatchConfig(const std::wstring& file, const std::wstring& nodePath, const std::wstring& agentScript,
    std::wstring& error);
