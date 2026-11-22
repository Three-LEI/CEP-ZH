# cep-zh 本地安装脚本（测试版）

> 这是**本地测试用**的一键安装脚本，还不是最终安装包。
> 已在本机完成 install → AE 启动/注入 → 字典热更新/实时开关 → uninstall 全流程测试，
> 详见 [本地测试记录](../docs/local-e2e-test.md)。

## 它能做什么

```text
install.ps1
  ├─ 扫描 CEPHtmlEngine.exe（D:\Adobe、Program Files、注册表 InstallLocation）
  ├─ 只处理 CEP 12（CEF 99），跳过 CEP 9/10/11
  ├─ 备份并安装 VCRUNTIME140_1.dll 代理
  ├─ 安装 CEP 面板到 %APPDATA%\Adobe\CEP\extensions\cep.zh.manager
  ├─ 安装 Agent 到 %LOCALAPPDATA%\CEP-ZH\agent
  ├─ 写 %APPDATA%\CEP-ZH\config.json（自动探测 node.exe）
  ├─ 写 %LOCALAPPDATA%\CEP-ZH\install.json
  └─ 写 HKCU 卸载入口
```

## 用法

```bat
:: 只看计划
powershell -NoProfile -ExecutionPolicy Bypass -File installer\install.ps1 -DryRun

:: 安装（D:\Adobe 自定义安装通常不需要管理员；Program Files 需要）
powershell -NoProfile -ExecutionPolicy Bypass -File installer\install.ps1

:: 卸载（恢复/删除代理，移除扩展/Agent/配置）
powershell -NoProfile -ExecutionPolicy Bypass -File installer\install.ps1 -Uninstall
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `-DryRun` | 只打印计划 |
| `-Silent` | 无提示（给未来安装包用） |
| `-KeepData` | 卸载时保留 `%APPDATA%\CEP-ZH` 字典/配置 |
| `-IncludeUnsupported` | 也处理 CEP 9/10/11（不推荐，代理偏移不同） |
| `-NodePath` | 指定 node.exe（默认 PATH / `C:\Program Files\nodejs`） |

## 要求

- Windows 10/11，PowerShell 5.1+；
- Adobe 应用 + CEP 12 扩展；
- Node.js **18+**（18 没有全局 WebSocket，Agent 用内置 `lib/ws.mjs`；22+ 用原生 WebSocket）；
- 写 `C:\Program Files` 下的引擎需要管理员；`D:\Adobe` 等自定义安装通常不需要。

## 已知限制

- 只验证 CEP 12 / CEF 99；旧版请用 `.debug` 模式；
- 安装脚本会修改 Adobe 引擎目录，必须先备份并保留卸载入口；
- 卸载入口写在 HKCU，适合当前用户；多用户机器需要各自安装/卸载；
- `UninstallString` 当前指向仓库里的 `installer\install.ps1`，最终安装包应把脚本复制到安装目录；
- 尚未打包 exe；下一步再决定 Inno Setup / WiX / 自研。
