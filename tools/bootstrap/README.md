# CEP 引擎代理（零 `.debug` 引导）

在 `CEPHtmlEngine` 目录放一个 5 KB 的 `VCRUNTIME140_1.dll`，在引擎调用 `cef_initialize()`
之前把 `cef_settings_t.remote_debugging_port` 设为分配端口。这样**每个扩展都不需要 `.debug`**，
所有 CEP 面板自动获得 CDP 调试端口。

## 目录

```text
dist/VCRUNTIME140_1.dll      编译好的代理（5 KB）
src/proxy.c                  源码
install-proxy.ps1            安装/卸载（备份/恢复/管理员检测）
install-proxy.cmd            双击包装
research/                    早期 launcher / IAT hook 研究代码（未用于产品）
```

## 工作原理

1. Windows 加载器在加载 `CEPHtmlEngine.exe` 时，优先从应用目录加载同名 `VCRUNTIME140_1.dll`；
2. 代理导出 `__CxxFrameHandler4`，转发到 System32 的真实 DLL，保证 C++ 异常展开正常；
3. `DllMain` 启动线程等 `libcef.dll` 加载，解析主程序导入表，把 `cef_initialize` 的 IAT 指向 wrapper；
4. wrapper 写 CEF 99 `cef_settings_t` 的 `remote_debugging_port`（偏移 372），再调用原函数；
5. 端口 = `CEP_ZH_PORT` 环境变量，或 `39600 + PID % 500`；
6. 只有 browser 进程（命令行无 `--type=`）会 patch；renderer/GPU 只负责转发 `__CxxFrameHandler4`。

## 安装

```bat
:: 先看计划
tools\bootstrap\install-proxy.cmd -DryRun

:: 安装（C:\Program Files 需要管理员；-Elevate 可自动请求 UAC）
tools\bootstrap\install-proxy.cmd
```

脚本会扫描 `D:\Adobe`、`C:\Program Files\Adobe`、`C:\Program Files (x86)\Adobe` 下的
所有 `CEPHtmlEngine.exe`，对每个目录：

- 备份已存在的 `VCRUNTIME140_1.dll` 为 `.cepzh-orig`；
- 写入代理；
- 重启 Adobe 应用后生效。

## 卸载

```bat
tools\bootstrap\install-proxy.cmd -Uninstall
```

恢复备份或删除代理，重启 Adobe 应用。

## 自行编译

代理是纯 C，无第三方库。可使用 [TinyCC](https://bellard.org/tcc/)（win64 版）或 MinGW：

```bat
tcc -shared -o VCRUNTIME140_1.dll src\proxy.c
```

编译后确认 DLL 含标记字符串 `cep-zh CEP engine proxy`，并更新 `dist`。

## 验证

```bat
:: 启动 Adobe 应用，打开任意 CEP 面板
node tools\cep-zh\cli.mjs status
```

应看到多个面板的端口，且 `enabledFiles` 为 0（没有任何 `.debug`）。
代理自己的日志在 `%TEMP%\cepzh-proxy.log`。

## 兼容性与限制

- 已验证：AE 2026、AI 2026、PS 2026、PR 2026 的 `CEPHtmlEngine.exe`；
- 依赖引擎**静态导入** `VCRUNTIME140_1.dll`；更老的 CEP 可能只导入 `VCRUNTIME140.dll`/`MSVCP140.dll`，
  需要另做代理或回退 `.debug`；
- 依赖 CEF 99 的 `cef_settings_t` 布局（`remote_debugging_port` 偏移 372）；CEF 大版本升级要重新核对；
- 修改 Adobe 安装目录，可能触发软件完整性检查/杀软；务必保留备份与卸载；
- 调试端口只绑定 `127.0.0.1`，但本机任意进程都能连上并执行面板 JS，按高权限调试接口对待。
