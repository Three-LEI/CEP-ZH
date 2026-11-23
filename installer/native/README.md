# CEP-ZH 原生安装器

单文件 Win32 / Direct2D 安装器，界面与管理面板一致。

## 兼容

- Adobe 2020 及以上
- CEP12：引擎代理 `VCRUNTIME140_1.dll`
- CEP9–11：按扩展写入 `.debug`
- 不支持 Adobe 2019 及更早版本

## 构建

```powershell
powershell -ExecutionPolicy Bypass -File installer\native\scripts\build.ps1
```

环境：Visual Studio 2022 Build Tools（MSVC v141）、Windows SDK 10.0.19041、CMake。

产物：

```text
installer\native\dist\CepZhInstaller.exe
```

## 工作流程

1. 从 GitHub 下载最新源码（优先 `gh-proxy.com`，回退 `ghproxy.net` / 直连）
2. 检测系统 Node；缺失时下载便携 Node 22
3. 安装管理面板和 Agent
4. 安装 `CEP汉化修复工具.exe`，用于无 PowerShell 的管理员 `.debug` 写入
5. CEP12 安装引擎代理；旧版写入 `.debug`
6. 写入 `debug-baseline.json`，供以后识别新插件
7. 创建桌面快捷方式

安装器申请管理员权限。要求关闭 Adobe 应用后再替换引擎文件。

## 维护

- `--preview`：只显示界面
- `--uninstall`：卸载并恢复引擎代理 / `.debug`
- 用户字典保留在 `%APPDATA%\CEP-ZH`

详细说明见根目录 README。
