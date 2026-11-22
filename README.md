# CEP-ZH

Adobe 2020 及以上版本的 CEP 面板通用汉化管理器。

[GitHub](https://github.com/Three-LEI/CEP-ZH) · [哔哩哔哩](https://space.bilibili.com/353544977)

## 兼容范围

- **支持：Adobe 2020 或更新版本**（PS / AE / AI / PR 等 CEP 面板）
- **不支持：Adobe 2019 及更早版本**
- Windows 10 / 11
- CEP 12：安装 `VCRUNTIME140_1.dll` 引擎代理，后续新插件自动获得调试端口
- CEP 9–11：使用 `.debug`；已有 `.debug` 的插件跳过
- 管理面板在小尺寸下自动切换为紧凑开关；最小可到 `150 × 200`

## 功能

- 不修改扩展源码，通过 CDP 注入翻译运行时
- 插件字典 / 公共字典，空译文回退公共字典
- 字典热更新、全局/单插件开关、AI 翻译
- 管理面板编辑字典、导入导出、自动捕获
- 新增插件检测：用户目录自动补 `.debug`，系统目录在面板提示并以管理员权限修复
- 原生 C++ 安装器：自动下载最新源码和 Node 运行时，带桌面快捷方式与卸载

## 构建安装器

环境：

- Visual Studio 2022 Build Tools（MSVC v141）
- Windows SDK 10.0.19041
- CMake

```powershell
powershell -ExecutionPolicy Bypass -File installer\native\scripts\build.ps1
```

产物：

```text
installer\native\dist\CepZhInstaller.exe
```

## 使用

1. 关闭所有 Adobe 应用。
2. 以管理员身份运行安装器。
3. ① 安装管理器 / Agent / Node 运行时。
4. ② 初始化 CEP 插件：CEP12 安装引擎代理，旧版写入 `.debug`。
5. 重启 Adobe 应用。
6. 打开：

```text
窗口 > 扩展 > CEP 汉化管理
```

之后日常使用不需要保持管理面板打开；隐藏 Agent 会随 Adobe 应用启动。

新增插件：

- CEP12 由引擎代理自动覆盖，不需要重新安装；
- CEP9–11 用户目录会自动补 `.debug`；
- 系统目录会显示修复提示。

卸载：安装器内点“卸载”，或运行：

```text
CepZhInstaller.exe --uninstall
```

## 目录

```text
product/cep.zh.manager   管理面板（HTML/CSS/JS）
tools/cep-zh             Agent、CLI、运行时和字典
tools/bootstrap          CEP12 引擎代理
installer/native         C++ 安装器
```

## 许可

代码使用 MIT License。

界面使用 MiSans 时遵循小米字体许可；公开仓库不单独分发 WOFF2 字体文件。
