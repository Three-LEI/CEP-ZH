#pragma once

#include <deque>
#include <functional>
#include <string>

constexpr wchar_t kCepZhVersion[] = L"0.3.2";

struct UiModel
{
    int progress = 0;
    bool busy = false;
    bool done = false;
    bool failed = false;
    bool installed = false;
    bool checking = false;
    bool updateAvailable = false;
    bool upToDate = false;
    bool checkFailed = false;
    std::wstring installedVersion;
    std::wstring latestVersion;
    std::wstring status = L"准备就绪";
    std::wstring step1 = L"等待";
    std::wstring step2 = L"等待";
    std::wstring error;
    std::deque<std::wstring> log;
};

using UiPublish = std::function<void(const std::function<void(UiModel&)>&)>;

// Runs the full download/install/.debug workflow. Returns false on failure and
// fills error. Publish is safe to call from a worker thread.
bool RunInstaller(const UiPublish& publish);

// Removes the manager/agent, generated .debug files and the desktop shortcut.
// User dictionaries under %APPDATA%\CEP-ZH are kept.
bool RunUninstall(const UiPublish& publish);

// Reads the latest GitHub Release tag. Returns false on network/API failure.
bool FetchLatestRelease(std::wstring& version, std::wstring& error);
