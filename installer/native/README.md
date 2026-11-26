# CEP-ZH 原生安装器

单文件 Win32 / Direct2D 安装器，界面与管理面板一致。

## 兼容

- Adobe 2019 及以上
- Windows 10 / 11
- 不支持 Windows 7、Windows 8 / 8.1
- CEP 9–12：统一使用官方 `.debug` 调试端口，已有 `.debug` 的插件保留
- 不再修改 Adobe 安装目录，不安装 `VCRUNTIME140_1.dll` 代理

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

1. 从 GitHub Release 获取 `CEP-ZH-manifest.json` 和 `.sig`，用内置 RSA 公钥验签
2. 按清单下载对应版本的运行时 ZIP，并校验 SHA-256
3. 检测系统 Node；缺失时下载并校验便携 Node 22
4. 安装管理面板、Agent 和 `CEP汉化修复工具.exe`
5. 管理面板安装包内置 MiSans Regular/Medium；升级时保留本机已有字体
6. 清理各版本 CEP 代码缓存
7. 为 CEP 9–12 写入 `.debug`；检测并恢复旧版遗留的引擎代理
8. 不创建桌面快捷方式，不把安装器复制到本机

安装器申请管理员权限。要求关闭 Adobe 应用后再替换文件。

## 维护

- `--preview`：只显示界面
- `--uninstall`：卸载并恢复生成的 `.debug`
- 用户字典保留在 `%APPDATA%\CEP-ZH`

详细说明见根目录 README。
