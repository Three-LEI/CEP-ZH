#pragma once

#include <deque>
#include <functional>
#include <string>

struct UiModel
{
    int progress = 0;
    bool busy = false;
    bool done = false;
    bool failed = false;
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
