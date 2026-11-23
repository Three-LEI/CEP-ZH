#include "installer.h"
#include "util.h"
#include "resource.h"

#include <windows.h>
#include <windowsx.h>
#include <d2d1.h>
#include <dwrite.h>
#include <shellapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iterator>
#include <mutex>
#include <regex>
#include <sstream>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace
{
constexpr wchar_t kWindowClass[] = L"CEP.ZH.Installer.Window";
constexpr wchar_t kWindowTitle[] = L"CEP 汉化管理器 · 安装器 v0.5.1";
constexpr int kWidth = 760;
constexpr int kHeight = 570;
constexpr UINT kMsgUpdate = WM_APP + 1;
constexpr UINT kMsgCheck = WM_APP + 2;

constexpr float kPad = 32.0f;
constexpr float kRight = 728.0f;
constexpr float kCard1Top = 104.0f;
constexpr float kCard2Top = 220.0f;
constexpr float kCardHeight = 104.0f;
constexpr float kProgressY = 342.0f;
constexpr float kBarY = 360.0f;
constexpr float kLogTop = 402.0f;
constexpr float kLogHeight = 78.0f;
constexpr float kButtonY = 500.0f;
constexpr float kButtonH = 38.0f;

struct Palette
{
    D2D1_COLOR_F bg = D2D1::ColorF(0xF7F6F2);
    D2D1_COLOR_F card = D2D1::ColorF(0xFFFFFF);
    D2D1_COLOR_F text = D2D1::ColorF(0x1B1B19);
    D2D1_COLOR_F muted = D2D1::ColorF(0x6F6E67);
    D2D1_COLOR_F faint = D2D1::ColorF(0x9B9A91);
    D2D1_COLOR_F line = D2D1::ColorF(0xD9D7CF);
    D2D1_COLOR_F strong = D2D1::ColorF(0xC4C2B8);
    D2D1_COLOR_F accent = D2D1::ColorF(0xD94F24);
    D2D1_COLOR_F accentSoft = D2D1::ColorF(0xD94F24, 0.10f);
    D2D1_COLOR_F success = D2D1::ColorF(0x2F7D54);
    D2D1_COLOR_F error = D2D1::ColorF(0xB23A1B);
    D2D1_COLOR_F dot = D2D1::ColorF(0x1B1B19, 0.10f);
    D2D1_COLOR_F grid = D2D1::ColorF(0x1B1B19, 0.045f);
};

struct UpdateFn
{
    std::function<void(UiModel&)> fn;
};

struct CheckResult
{
    bool ok = false;
    std::wstring latest;
    std::wstring error;
};

Palette g_palette;
UiModel g_model;
std::mutex g_mutex;
bool g_busy = false;
int g_dpi = 96;
int g_hover = -1;
HWND g_hwnd = nullptr;
int g_operation = 0; // 0 = install, 1 = uninstall
float g_uiScale = 1.0f;
LONG g_fixedWindowW = 0;
LONG g_fixedWindowH = 0;
bool g_fixedWindow = false;

ComPtr<ID2D1Factory> g_d2d;
ComPtr<IDWriteFactory> g_dw;
ComPtr<ID2D1HwndRenderTarget> g_rt;
ComPtr<ID2D1SolidColorBrush> g_brush;
ComPtr<IDWriteTextFormat> g_fmtTitle;
ComPtr<IDWriteTextFormat> g_fmtSub;
ComPtr<IDWriteTextFormat> g_fmtStep;
ComPtr<IDWriteTextFormat> g_fmtBody;
ComPtr<IDWriteTextFormat> g_fmtSmall;
ComPtr<IDWriteTextFormat> g_fmtMono;
ComPtr<IDWriteTextFormat> g_fmtNumber;
ComPtr<IDWriteTextFormat> g_fmtButton;

D2D1_RECT_F Rect(float l, float t, float r, float b) { return D2D1::RectF(l, t, r, b); }

int Scale(int value) { return static_cast<int>(std::lround(value * (g_dpi / 96.0) * g_uiScale)); }

int DpiForWindow(HWND hwnd);
int SystemDpi();

float ComputeUiScale(int dpi)
{
    RECT work{};
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)) {
        work = RECT{ 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN) };
    }
    const double availW = (work.right - work.left) * 96.0 / dpi - 48.0;
    const double availH = (work.bottom - work.top) * 96.0 / dpi - 80.0;
    const double scale = std::min({ 1.0, availW / kWidth, availH / kHeight });
    return static_cast<float>(std::max(0.66, scale));
}

void ApplyWindowMetrics(HWND hwnd)
{
    g_dpi = DpiForWindow(hwnd);
    g_uiScale = ComputeUiScale(g_dpi);
    RECT rc{ 0, 0,
        static_cast<LONG>(std::lround(kWidth * (g_dpi / 96.0) * g_uiScale)),
        static_cast<LONG>(std::lround(kHeight * (g_dpi / 96.0) * g_uiScale)) };
    AdjustWindowRectEx(&rc, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE, 0);
    const int width = rc.right - rc.left;
    const int height = rc.bottom - rc.top;
    RECT work{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const int x = static_cast<int>(work.left) + std::max(0, static_cast<int>(((work.right - work.left) - width) / 2));
    const int y = static_cast<int>(work.top) + std::max(0, static_cast<int>(((work.bottom - work.top) - height) / 2));
    SetWindowPos(hwnd, nullptr, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
    g_fixedWindowW = width;
    g_fixedWindowH = height;
    g_fixedWindow = true;
    SetWindowTextW(hwnd, kWindowTitle);
}

int DpiForWindow(HWND hwnd)
{
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    static auto fn = reinterpret_cast<GetDpiForWindowFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    if (fn) {
        const UINT dpi = fn(hwnd);
        if (dpi >= 72 && dpi <= 480) return static_cast<int>(dpi);
    }
    HDC dc = GetDC(nullptr);
    const int dpi = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
    if (dc) ReleaseDC(nullptr, dc);
    return (dpi >= 72 && dpi <= 480) ? dpi : 96;
}

int SystemDpi()
{
    using GetDpiForSystemFn = UINT(WINAPI*)();
    static auto fn = reinterpret_cast<GetDpiForSystemFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForSystem"));
    if (fn) {
        const UINT dpi = fn();
        if (dpi >= 72 && dpi <= 480) return static_cast<int>(dpi);
    }
    HDC dc = GetDC(nullptr);
    const int dpi = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
    if (dc) ReleaseDC(nullptr, dc);
    return (dpi >= 72 && dpi <= 480) ? dpi : 96;
}

void EnableDpiAwareness()
{
    using SetCtxFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    static auto fn = reinterpret_cast<SetCtxFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
    if (fn) {
        fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        return;
    }
    SetProcessDPIAware();
}

bool IsAdmin()
{
    BOOL admin = FALSE;
    PSID group = nullptr;
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    if (AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &group)) {
        CheckTokenMembership(nullptr, group, &admin);
        FreeSid(group);
    }
    return admin != FALSE;
}

bool HasFamily(IDWriteFactory* factory, const wchar_t* name)
{
    ComPtr<IDWriteFontCollection> collection;
    if (!factory || FAILED(factory->GetSystemFontCollection(collection.GetAddressOf(), FALSE)))
        return false;
    UINT32 index = 0;
    BOOL exists = FALSE;
    return SUCCEEDED(collection->FindFamilyName(name, &index, &exists)) && exists;
}

std::wstring UiFamily(IDWriteFactory* factory)
{
    if (HasFamily(factory, L"Microsoft YaHei UI")) return L"Microsoft YaHei UI";
    if (HasFamily(factory, L"Microsoft YaHei")) return L"Microsoft YaHei";
    return L"Segoe UI";
}

std::wstring MonoFamily(IDWriteFactory* factory)
{
    if (HasFamily(factory, L"Consolas")) return L"Consolas";
    if (HasFamily(factory, L"Courier New")) return L"Courier New";
    return UiFamily(factory);
}

bool CreateFormat(const std::wstring& family, float size, DWRITE_FONT_WEIGHT weight,
    DWRITE_TEXT_ALIGNMENT align, IDWriteTextFormat** out)
{
    if (!g_dw || FAILED(g_dw->CreateTextFormat(family.c_str(), nullptr, weight,
            DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, L"zh-CN", out)))
        return false;
    (*out)->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    (*out)->SetTextAlignment(align);
    (*out)->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    return true;
}

bool CreateDeviceResources()
{
    if (g_rt) return true;
    if (!g_d2d) {
        if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, g_d2d.GetAddressOf())))
            return false;
    }
    if (!g_dw) {
        if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown**>(g_dw.GetAddressOf()))))
            return false;
    }

    const std::wstring ui = UiFamily(g_dw.Get());
    const std::wstring mono = MonoFamily(g_dw.Get());
    if (!g_fmtTitle) CreateFormat(ui, 22.0f, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtTitle.GetAddressOf());
    if (!g_fmtSub) CreateFormat(mono, 9.0f, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtSub.GetAddressOf());
    if (!g_fmtStep) CreateFormat(ui, 15.0f, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtStep.GetAddressOf());
    if (!g_fmtBody) CreateFormat(ui, 11.0f, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtBody.GetAddressOf());
    if (!g_fmtSmall) CreateFormat(ui, 10.0f, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtSmall.GetAddressOf());
    if (!g_fmtMono) CreateFormat(mono, 9.0f, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtMono.GetAddressOf());
    if (!g_fmtNumber) CreateFormat(mono, 24.0f, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_ALIGNMENT_LEADING, g_fmtNumber.GetAddressOf());
    if (!g_fmtButton) CreateFormat(ui, 11.0f, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_TEXT_ALIGNMENT_CENTER, g_fmtButton.GetAddressOf());
    if (!g_fmtBody || !g_fmtTitle) return false;

    RECT rc{};
    GetClientRect(g_hwnd, &rc);
    const D2D1_SIZE_U size = D2D1::SizeU(static_cast<UINT32>(rc.right - rc.left),
        static_cast<UINT32>(rc.bottom - rc.top));
    if (FAILED(g_d2d->CreateHwndRenderTarget(D2D1::RenderTargetProperties(),
            D2D1::HwndRenderTargetProperties(g_hwnd, size), g_rt.GetAddressOf())))
        return false;
    g_rt->SetDpi(static_cast<float>(g_dpi) * g_uiScale, static_cast<float>(g_dpi) * g_uiScale);
    if (FAILED(g_rt->CreateSolidColorBrush(g_palette.text, g_brush.GetAddressOf())))
        return false;
    return true;
}

void DiscardDeviceResources()
{
    g_brush.Reset();
    g_rt.Reset();
}

void Fill(const D2D1_RECT_F& rect, const D2D1_COLOR_F& color)
{
    if (!g_brush) return;
    g_brush->SetColor(color);
    g_rt->FillRectangle(rect, g_brush.Get());
}

void Stroke(const D2D1_RECT_F& rect, const D2D1_COLOR_F& color, float width = 1.0f)
{
    if (!g_brush) return;
    g_brush->SetColor(color);
    g_rt->DrawRectangle(rect, g_brush.Get(), width);
}

void Line(float x1, float y1, float x2, float y2, const D2D1_COLOR_F& color, float width = 1.0f)
{
    if (!g_brush) return;
    g_brush->SetColor(color);
    g_rt->DrawLine(D2D1::Point2F(x1, y1), D2D1::Point2F(x2, y2), g_brush.Get(), width);
}

void Text(const std::wstring& value, IDWriteTextFormat* format, const D2D1_RECT_F& rect,
    const D2D1_COLOR_F& color)
{
    if (!g_brush || !format || value.empty()) return;
    g_brush->SetColor(color);
    g_rt->DrawTextW(value.c_str(), static_cast<UINT32>(value.size()), format, rect, g_brush.Get(),
        D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
}

std::wstring PercentText(int value)
{
    return std::to_wstring(value) + L"%";
}

D2D1_COLOR_F StepColor(const std::wstring& text)
{
    if (text.find(L"失败") != std::wstring::npos) return g_palette.error;
    if (text.find(L"完成") != std::wstring::npos) return g_palette.success;
    if (text.find(L"等待") != std::wstring::npos) return g_palette.faint;
    return g_palette.accent;
}

void DrawBackground()
{
    if (!g_rt) return;
    g_rt->Clear(g_palette.bg);

    for (float y = 16.0f; y < kHeight; y += 22.0f) {
        for (float x = 16.0f; x < kWidth; x += 22.0f) {
            g_brush->SetColor(g_palette.dot);
            g_rt->FillEllipse(D2D1::Ellipse(D2D1::Point2F(x, y), 0.7f, 0.7f), g_brush.Get());
        }
    }
    for (float x = 0.0f; x < kWidth; x += 110.0f) {
        g_brush->SetColor(g_palette.grid);
        g_rt->DrawLine(D2D1::Point2F(x, 0), D2D1::Point2F(x, kHeight), g_brush.Get(), 1.0f);
    }
    for (float y = 78.0f; y < kHeight; y += 110.0f) {
        g_brush->SetColor(g_palette.grid);
        g_rt->DrawLine(D2D1::Point2F(0, y), D2D1::Point2F(kWidth, y), g_brush.Get(), 1.0f);
    }
    if (g_brush) {
        g_brush->SetColor(D2D1::ColorF(0xD9D7CF, 0.55f));
        g_rt->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(760, 20), 170, 170), g_brush.Get(), 1.0f);
    }
}

void DrawHeader()
{
    Text(L"CEP 汉化管理器", g_fmtTitle.Get(), Rect(kPad, 16, 560, 46), g_palette.text);
    Text(L"DOWNLOADER / CEP-ZH", g_fmtSub.Get(), Rect(kPad, 49, 500, 66), g_palette.accent);
    Text(std::wstring(L"v") + kCepZhVersion, g_fmtSub.Get(), Rect(660, 18, kRight, 34), g_palette.muted);
    Line(kPad, 78.0f, kRight, 78.0f, g_palette.strong);
    Text(std::wstring(L"INSTALLED  ") +
        (g_model.installed ? L"v" + g_model.installedVersion : L"no") +
        L"  ·  LATEST  " + (g_model.latestVersion.empty() ? L"checking" : L"v" + g_model.latestVersion),
        g_fmtMono.Get(), Rect(kPad, 88, kRight, 102), g_palette.muted);
}

void DrawCard(float top, const wchar_t* number, const wchar_t* title, const wchar_t* desc,
    const std::wstring& step)
{
    const D2D1_RECT_F rect = Rect(kPad, top, kRight, top + kCardHeight);
    Fill(rect, g_palette.card);
    Stroke(rect, g_palette.line);
    Line(rect.left, rect.top, rect.left + 12, rect.top, g_palette.accent, 2.0f);
    Line(rect.right - 12, rect.bottom, rect.right, rect.bottom, g_palette.accent, 2.0f);

    Text(number, g_fmtNumber.Get(), Rect(rect.left + 16, rect.top + 20, rect.left + 72, rect.top + 60),
        g_palette.accent);
    Text(title, g_fmtStep.Get(), Rect(rect.left + 76, rect.top + 18, rect.right - 150, rect.top + 42),
        g_palette.text);
    Text(desc, g_fmtSmall.Get(), Rect(rect.left + 76, rect.top + 46, rect.right - 24, rect.top + 64),
        g_palette.muted);
    Text(step, g_fmtMono.Get(), Rect(rect.left + 76, rect.top + 72, rect.right - 24, rect.top + 90),
        StepColor(step));
}

void DrawProgress()
{
    Text(L"INSTALL PROGRESS", g_fmtSub.Get(), Rect(kPad, 340, 420, 354), g_palette.accent);
    Text(PercentText(g_model.progress), g_fmtMono.Get(), Rect(650, 340, kRight, 354), g_palette.muted);

    const D2D1_RECT_F bar = Rect(kPad, 360, kRight, 368);
    Fill(bar, g_palette.card);
    Stroke(bar, g_palette.strong);
    if (g_model.progress > 0) {
        const float width = (kRight - kPad) * (std::min(100, g_model.progress) / 100.0f);
        Fill(Rect(kPad, 360, kPad + width, 368), g_palette.accent);
    }
    Text(g_model.status, g_fmtBody.Get(), Rect(kPad, 378, kRight, 396), g_palette.text);
}

void DrawLog()
{
    const D2D1_RECT_F rect = Rect(kPad, kLogTop, kRight, kLogTop + kLogHeight);
    Fill(rect, g_palette.card);
    Stroke(rect, g_palette.line);
    Text(L"LOG", g_fmtSub.Get(), Rect(rect.left + 12, rect.top + 8, rect.right - 12, rect.top + 20),
        g_palette.faint);
    float y = rect.top + 24;
    for (const auto& line : g_model.log) {
        Text(line, g_fmtMono.Get(), Rect(rect.left + 12, y, rect.right - 12, y + 15), g_palette.muted);
        y += 15;
        if (y > rect.bottom - 12) break;
    }
}

void DrawButton(int id, const D2D1_RECT_F& rect, const std::wstring& label, bool primary, bool enabled)
{
    const bool hover = enabled && g_hover == id;
    D2D1_COLOR_F fill = primary ? g_palette.text : g_palette.card;
    D2D1_COLOR_F border = primary ? g_palette.text : g_palette.strong;
    D2D1_COLOR_F textColor = primary ? g_palette.bg : g_palette.text;
    if (!enabled) {
        fill = primary ? g_palette.strong : g_palette.card;
        border = g_palette.line;
        textColor = g_palette.faint;
    } else if (hover) {
        fill = primary ? g_palette.accent : g_palette.accentSoft;
        border = primary ? g_palette.accent : g_palette.accent;
        textColor = primary ? g_palette.bg : g_palette.accent;
    }
    Fill(rect, fill);
    Stroke(rect, border);
    Text(label, g_fmtButton.Get(), Rect(rect.left + 6, rect.top, rect.right - 6, rect.bottom), textColor);
}

void DrawFooter()
{
    Line(kPad, 548, kRight, 548, g_palette.line);
    Text(IsAdmin() ? L"ADMIN / ELEVATED" : L"USER / NOT ELEVATED", g_fmtSub.Get(),
        Rect(kPad, 552, 260, 566), IsAdmin() ? g_palette.success : g_palette.error);
    Text(std::wstring(L"v") + kCepZhVersion + L" · three-lei × deepseek", g_fmtMono.Get(),
        Rect(280, 552, 560, 566), g_palette.muted);
    Text(L"MIT", g_fmtMono.Get(), Rect(650, 552, kRight, 566), g_palette.faint);
}

bool IsCepZhInstalled(std::wstring& version)
{
    version.clear();
    const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
    const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
    const std::wstring manager = JoinPath(JoinPath(JoinPath(roaming, L"Adobe"), L"CEP"),
        L"extensions\\cep.zh.manager\\index.html");
    const std::wstring agent = JoinPath(JoinPath(JoinPath(local, L"CEP-ZH"), L"agent"),
        L"tools\\cep-zh\\agent.mjs");
    if (!FileExists(manager) || !FileExists(agent)) return false;

    const std::wstring versionFile = JoinPath(JoinPath(local, L"CEP-ZH"), L"version.json");
    std::wstring text;
    if (ReadTextFile(versionFile, text)) {
        std::wsmatch match;
        if (std::regex_search(text, match, std::wregex(L"\"version\"\\s*:\\s*\"v?([0-9.]+)\""))
            && match.size() > 1) {
            version = match[1].str();
        }
    }
    if (version.empty()) {
        if (ReadTextFile(manager, text)) {
            std::wsmatch match;
            if (std::regex_search(text, match, std::wregex(L"v([0-9]+\\.[0-9]+\\.[0-9]+)"))
                && match.size() > 1) {
                version = match[1].str();
            }
        }
    }
    if (version.empty()) version = L"unknown";
    return true;
}

bool IsNewerVersion(const std::wstring& latest, const std::wstring& current)
{
    auto parts = [](const std::wstring& value) {
        std::vector<int> out;
        std::wstringstream stream(value);
        std::wstring part;
        while (std::getline(stream, part, L'.')) {
            try { out.push_back(std::stoi(part)); } catch (...) { out.push_back(0); }
        }
        return out;
    };
    const auto a = parts(latest);
    const auto b = parts(current);
    for (size_t i = 0; i < std::max(a.size(), b.size()); ++i) {
        const int x = i < a.size() ? a[i] : 0;
        const int y = i < b.size() ? b[i] : 0;
        if (x != y) return x > y;
    }
    return false;
}

void RefreshInstalledState()
{
    std::wstring version;
    g_model.installed = IsCepZhInstalled(version);
    g_model.installedVersion = version;
    g_model.checking = false;
    g_model.updateAvailable = false;
    g_model.upToDate = false;
    g_model.checkFailed = false;
    if (g_model.installed) {
        g_model.status = version == L"unknown"
            ? L"已安装 CEP-ZH，正在检查更新…"
            : L"已安装 v" + version + L"，正在检查更新…";
    } else {
        g_model.latestVersion = kCepZhVersion;
        g_model.status = L"尚未安装，可以开始安装 v" + std::wstring(kCepZhVersion);
    }
}

std::wstring InstallActionLabel()
{
    if (g_model.busy) return g_operation == 1 ? L"卸载中…" : L"安装中…";
    if (!g_model.installed) return L"开始安装 v" + std::wstring(kCepZhVersion);
    if (g_model.checking) return L"正在检查更新…";
    if (g_model.checkFailed) return L"检查更新失败 · 重试";
    if (g_model.updateAvailable) return L"立即更新 v" + g_model.latestVersion;
    if (g_model.upToDate) return L"已是最新 v" + g_model.installedVersion;
    return L"正在检查更新…";
}

bool InstallActionEnabled()
{
    if (g_model.busy) return false;
    if (!g_model.installed) return true;
    if (g_model.checking) return false;
    if (g_model.checkFailed) return true;
    return g_model.updateAvailable;
}

void Paint()
{
    if (!g_rt) return;
    g_rt->BeginDraw();
    DrawBackground();
    DrawHeader();

    const bool busy = g_model.busy;
    DrawCard(kCard1Top, L"01", L"安装 CEP 汉化文件",
        L"从 GitHub 下载最新 source，安装管理器、Agent 与 Node.js 运行时。", g_model.step1);
    DrawCard(kCard2Top, L"02", L"初始化 CEP 插件 (.debug)",
        L"CEP12 自动装引擎代理；旧版扫描 .debug，已有跳过，缺失时写入。", g_model.step2);

    DrawProgress();
    DrawLog();

    DrawButton(0, Rect(kPad, kButtonY, 192, kButtonY + kButtonH),
        InstallActionLabel().c_str(), true, InstallActionEnabled());
    DrawButton(1, Rect(204, kButtonY, 340, kButtonY + kButtonH), L"打开扩展目录", false, true);
    DrawButton(2, Rect(352, kButtonY, 462, kButtonY + kButtonH), L"打开日志", false, true);
    DrawButton(4, Rect(480, kButtonY, 600, kButtonY + kButtonH), L"卸载", false, !busy);
    DrawButton(3, Rect(632, kButtonY, kRight, kButtonY + kButtonH), L"退出", false, true);

    DrawFooter();
    g_rt->EndDraw();
}

void PublishFromWorker(HWND hwnd, const std::function<void(UiModel&)>& fn)
{
    auto* update = new UpdateFn{fn};
    if (!PostMessageW(hwnd, kMsgUpdate, 0, reinterpret_cast<LPARAM>(update)))
        delete update;
}

void StartUpdateCheck(HWND hwnd)
{
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_model.checking = true;
        g_model.checkFailed = false;
        g_model.latestVersion.clear();
        g_model.status = L"正在检查 GitHub Release…";
    }
    InvalidateRect(hwnd, nullptr, FALSE);
    std::thread([hwnd]() {
        auto* result = new CheckResult{};
        result->ok = FetchLatestRelease(result->latest, result->error);
        if (!PostMessageW(hwnd, kMsgCheck, 0, reinterpret_cast<LPARAM>(result)))
            delete result;
    }).detach();
}

void StartInstall(HWND hwnd)
{
    if (g_busy) return;
    g_operation = 0;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        const bool installed = g_model.installed;
        const std::wstring installedVersion = g_model.installedVersion;
        const std::wstring latestVersion = g_model.latestVersion;
        g_model = UiModel{};
        g_model.installed = installed;
        g_model.installedVersion = installedVersion;
        g_model.latestVersion = latestVersion;
        g_model.busy = true;
        g_model.status = L"准备下载…";
        g_model.step1 = L"等待";
        g_model.step2 = L"等待";
        g_model.log.clear();
    }
    g_busy = true;
    InvalidateRect(hwnd, nullptr, FALSE);
    std::thread([hwnd]() {
        RunInstaller([hwnd](const std::function<void(UiModel&)>& fn) {
            PublishFromWorker(hwnd, fn);
        });
    }).detach();
}

void StartUninstall(HWND hwnd, bool confirm = true)
{
    if (g_busy) return;
    if (confirm && MessageBoxW(hwnd,
            L"确定卸载 CEP 汉化管理器？\n\n"
            L"将移除管理器、Agent、生成的 .debug 和桌面快捷方式。\n"
            L"字典、AI 配置将保留在 %APPDATA%\\CEP-ZH。",
            L"卸载 CEP 汉化管理器", MB_YESNO | MB_ICONQUESTION) != IDYES)
        return;

    g_operation = 1;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_model = UiModel{};
        g_model.busy = true;
        g_model.status = L"准备卸载…";
        g_model.step1 = L"等待";
        g_model.step2 = L"等待";
        g_model.log.clear();
    }
    g_busy = true;
    InvalidateRect(hwnd, nullptr, FALSE);
    std::thread([hwnd]() {
        RunUninstall([hwnd](const std::function<void(UiModel&)>& fn) {
            PublishFromWorker(hwnd, fn);
        });
    }).detach();
}

void ApplyPreview()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_model = UiModel{};
    g_model.progress = 62;
    g_model.busy = false;
    g_model.done = false;
    g_model.status = L"下载 CEP-ZH  1.4 MB / 2.1 MB";
    g_model.step1 = L"下载 CEP 汉化文件";
    g_model.step2 = L"等待";
    g_model.log.push_back(L"Node.js: C:\\Program Files\\nodejs\\node.exe");
    g_model.log.push_back(L"下载源：gh-proxy.com / GitHub 直连回退");
}

void OpenPath(const std::wstring& path)
{
    ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void OpenExtensionDir()
{
    const std::wstring path = JoinPath(KnownFolder(FOLDERID_RoamingAppData),
        L"Adobe\\CEP\\extensions\\cep.zh.manager");
    if (DirectoryExists(path)) OpenPath(path);
    else OpenPath(JoinPath(KnownFolder(FOLDERID_RoamingAppData), L"Adobe\\CEP\\extensions"));
}

void OpenLog()
{
    const std::wstring path = JoinPath(TempDirectory(), L"CEP-ZH-installer.log");
    if (!FileExists(path)) {
        std::wstring text;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            text = g_model.status + L"\r\n";
            for (const auto& line : g_model.log) text += line + L"\r\n";
        }
        WriteTextFile(path, text);
    }
    OpenPath(path);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE:
        g_hwnd = hwnd;
        return 0;
    case WM_PAINT:
    {
        PAINTSTRUCT ps{};
        BeginPaint(hwnd, &ps);
        if (CreateDeviceResources()) Paint();
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    case WM_SIZE:
        if (g_rt) {
            const UINT w = LOWORD(lParam);
            const UINT h = HIWORD(lParam);
            if (w && h) g_rt->Resize(D2D1::SizeU(w, h));
        }
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    case WM_SYSCOMMAND:
        if ((wParam & 0xFFF0) == SC_MAXIMIZE || (wParam & 0xFFF0) == SC_SIZE) return 0;
        break;
    case WM_GETMINMAXINFO:
        if (g_fixedWindow) {
            MINMAXINFO* info = reinterpret_cast<MINMAXINFO*>(lParam);
            info->ptMinTrackSize.x = g_fixedWindowW;
            info->ptMinTrackSize.y = g_fixedWindowH;
            info->ptMaxTrackSize.x = g_fixedWindowW;
            info->ptMaxTrackSize.y = g_fixedWindowH;
            return 0;
        }
        break;
    case WM_NCLBUTTONDBLCLK:
        // Double-clicking the caption must not maximize the fixed tool window.
        if (wParam == HTCAPTION) return 0;
        break;
    case WM_TIMER:
        if (wParam == 42) {
            KillTimer(hwnd, 42);
            ApplyWindowMetrics(hwnd);
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        break;
    case WM_DPICHANGED:
    {
        DiscardDeviceResources();
        g_fixedWindow = false;
        ApplyWindowMetrics(hwnd);
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    }
    case WM_MOUSEMOVE:
    {
        const int x = GET_X_LPARAM(lParam);
        const int y = GET_Y_LPARAM(lParam);
        int hover = -1;
        if (y >= Scale(static_cast<int>(kButtonY)) && y <= Scale(static_cast<int>(kButtonY + kButtonH))) {
            if (x >= Scale(32) && x <= Scale(192)) hover = 0;
            else if (x >= Scale(204) && x <= Scale(340)) hover = 1;
            else if (x >= Scale(352) && x <= Scale(462)) hover = 2;
            else if (x >= Scale(480) && x <= Scale(600)) hover = 4;
            else if (x >= Scale(632) && x <= Scale(728)) hover = 3;
        }
        if (hover != g_hover) { g_hover = hover; InvalidateRect(hwnd, nullptr, FALSE); }
        return 0;
    }
    case WM_SETCURSOR:
        if (LOWORD(lParam) == HTCLIENT && g_hover >= 0) {
            SetCursor(LoadCursorW(nullptr, IDC_HAND));
            return TRUE;
        }
        break;
    case WM_LBUTTONDOWN:
    {
        const int x = GET_X_LPARAM(lParam);
        const int y = GET_Y_LPARAM(lParam);
        if (y >= Scale(static_cast<int>(kButtonY)) && y <= Scale(static_cast<int>(kButtonY + kButtonH))) {
            if (x >= Scale(32) && x <= Scale(192)) {
                if (!InstallActionEnabled()) return 0;
                if (g_model.installed && g_model.checkFailed && !g_model.updateAvailable) {
                    StartUpdateCheck(hwnd);
                } else {
                    StartInstall(hwnd);
                }
                return 0;
            }
            if (x >= Scale(204) && x <= Scale(340)) { OpenExtensionDir(); return 0; }
            if (x >= Scale(352) && x <= Scale(462)) { OpenLog(); return 0; }
            if (x >= Scale(480) && x <= Scale(600)) { StartUninstall(hwnd); return 0; }
            if (x >= Scale(632) && x <= Scale(728)) { DestroyWindow(hwnd); return 0; }
        }
        return 0;
    }
    case kMsgCheck:
    {
        auto* result = reinterpret_cast<CheckResult*>(lParam);
        if (result) {
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                g_model.checking = false;
                if (!result->ok) {
                    g_model.checkFailed = true;
                    g_model.updateAvailable = false;
                    g_model.upToDate = false;
                    g_model.status = L"检查更新失败：" + result->error;
                } else {
                    g_model.latestVersion = result->latest;
                    g_model.checkFailed = false;
                    if (!g_model.installed) {
                        g_model.updateAvailable = false;
                        g_model.upToDate = false;
                        g_model.status = L"尚未安装，可以开始安装 v" + std::wstring(kCepZhVersion);
                    } else {
                        g_model.updateAvailable = IsNewerVersion(result->latest, g_model.installedVersion);
                        g_model.upToDate = !g_model.updateAvailable;
                        g_model.status = g_model.updateAvailable
                            ? L"发现新版本 v" + result->latest + L"，可立即更新"
                            : L"已安装 v" + g_model.installedVersion + L"，已是最新版本";
                    }
                }
            }
            delete result;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }
    case kMsgUpdate:
    {
        auto* update = reinterpret_cast<UpdateFn*>(lParam);
        if (update) {
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                const bool installed = g_model.installed;
                const bool checking = g_model.checking;
                const bool updateAvailable = g_model.updateAvailable;
                const bool upToDate = g_model.upToDate;
                const bool checkFailed = g_model.checkFailed;
                const std::wstring installedVersion = g_model.installedVersion;
                const std::wstring latestVersion = g_model.latestVersion;
                const int operation = g_operation;
                update->fn(g_model);
                g_model.installed = installed;
                g_model.checking = checking;
                g_model.updateAvailable = updateAvailable;
                g_model.upToDate = upToDate;
                g_model.checkFailed = checkFailed;
                g_model.installedVersion = installedVersion;
                g_model.latestVersion = latestVersion;
                if (!g_model.busy && g_model.done) {
                    if (operation == 0) {
                        g_model.installed = true;
                        g_model.installedVersion = kCepZhVersion;
                        g_model.latestVersion = kCepZhVersion;
                        g_model.updateAvailable = false;
                        g_model.upToDate = true;
                        g_model.checking = false;
                        g_model.checkFailed = false;
                    } else if (operation == 1) {
                        g_model.installed = false;
                        g_model.installedVersion.clear();
                        g_model.latestVersion.clear();
                        g_model.updateAvailable = false;
                        g_model.upToDate = false;
                        g_model.checking = false;
                        g_model.checkFailed = false;
                    }
                } else if (!g_model.busy && operation == 0 && g_model.failed) {
                    // A failed update must leave the update button usable.
                    g_model.updateAvailable = g_model.installed;
                    g_model.upToDate = false;
                    g_model.checkFailed = false;
                }
                g_busy = g_model.busy;
                if (!g_model.busy && operation == 1) g_operation = 0;
            }
            delete update;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }
    case WM_CLOSE:
        if (g_busy) return 0;
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        break;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show)
{
    if (!IsAdmin()) {
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        std::wstring params;
        if (argv) {
            for (int i = 1; i < argc; ++i) params += L" " + QuoteArg(argv[i]);
            LocalFree(argv);
        }
        wchar_t self[MAX_PATH * 4]{};
        if (!GetModuleFileNameW(nullptr, self, (DWORD)std::size(self))) return 1;
        SHELLEXECUTEINFOW sei{};
        sei.cbSize = sizeof(sei);
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = L"runas";
        sei.lpFile = self;
        sei.lpParameters = params.empty() ? nullptr : params.c_str();
        sei.nShow = show;
        if (!ShellExecuteExW(&sei)) return 1;
        if (sei.hProcess) CloseHandle(sei.hProcess);
        return 0;
    }

    const bool preview = wcsstr(GetCommandLineW(), L"--preview") != nullptr;
    const bool autoStart = wcsstr(GetCommandLineW(), L"--auto") != nullptr;
    const bool autoUninstall = wcsstr(GetCommandLineW(), L"--uninstall") != nullptr;
    if (preview) ApplyPreview();

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP));
    wc.hIconSm = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP));
    wc.hbrBackground = nullptr;
    wc.lpszClassName = kWindowClass;
    if (!RegisterClassExW(&wc)) return 1;

    const int dpi = SystemDpi();
    g_dpi = (dpi >= 72 && dpi <= 480) ? dpi : 96;
    g_uiScale = ComputeUiScale(g_dpi);
    RECT rc{ 0, 0,
        static_cast<LONG>(std::lround(kWidth * (g_dpi / 96.0) * g_uiScale)),
        static_cast<LONG>(std::lround(kHeight * (g_dpi / 96.0) * g_uiScale)) };
    AdjustWindowRectEx(&rc, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, FALSE, 0);
    const int width = rc.right - rc.left;
    const int height = rc.bottom - rc.top;
    const int x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
    const int y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;

    HWND hwnd = CreateWindowExW(0, kWindowClass, kWindowTitle,
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
        x, y, width, height, nullptr, nullptr, instance, nullptr);
    if (!hwnd) return 1;
    ApplyWindowMetrics(hwnd);

    if (!preview) {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_model.status = L"点击“开始安装”";
        g_model.step1 = L"等待";
        g_model.step2 = L"等待";
        g_model.log.push_back(L"下载源：github.com/Three-LEI/CEP-ZH");
        g_model.log.push_back(IsAdmin() ? L"管理员权限：已获取" : L"管理员权限：未获取");
    }
    if (!preview) {
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            RefreshInstalledState();
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        if (g_model.installed) StartUpdateCheck(hwnd);
    }

    ShowWindow(hwnd, show);
    UpdateWindow(hwnd);
    ApplyWindowMetrics(hwnd);
    SetTimer(hwnd, 42, 150, nullptr);
    if (autoStart) StartInstall(hwnd);
    else if (autoUninstall) StartUninstall(hwnd, false);

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
