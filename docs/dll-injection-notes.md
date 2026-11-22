# DLL 注入路线实验记录

> 结论：**同用户远程注入 CEPHtmlEngine 本身可行，但“晚注入 + 改 CefSettings”不可行**；
> 要无 `.debug` 开端口，必须在 `cef_initialize()` 之前进入进程。最终采用加载器阶段的
> `VCRUNTIME140_1.dll` 代理，而不是运行期 `CreateRemoteThread` 注入。

## 1. 目标

- 不写每个扩展的 `.debug`；
- 不修改扩展文件；
- 尽量不要求管理员；
- 在 CEPHtmlEngine 里获得 JS 执行能力（端口或直接执行）。

## 2. 已验证的事实

### 2.1 同用户注入可行

用 `OpenProcess + VirtualAllocEx + WriteProcessMemory + CreateRemoteThread(LoadLibraryA)`
把一个 `hello.dll` 注入到手工启动的 `CEPHtmlEngine.exe`：

```text
inject: ok
log: hello
```

没有管理员权限，进程同为当前用户中完整性级别。说明“能进进程”不是障碍。

### 2.2 晚注入改 CefSettings 无效

把带 IAT hook 的 `cepzh-hook.dll` 注入到已经启动的引擎：

```text
DllMain pid=22396 port=39515
IAT patched real=00007FFF6C1D1240
（没有 cef_initialize 日志，端口没有打开）
```

引擎日志显示注入时已经走到：

```text
WARN  No debug port file found.
TEST-LOADEXTENSION-PERFORMANCE, CEPHTMLENGINE, CreateBrowser begin.
```

即 `cef_initialize()` 早已执行完，改 `CefSettings` 太晚。

### 2.3 命令行开关不生效

手工启动引擎时尝试：

- 追加 `--remote-debugging-port=39500`；
- 把 `--remote-debugging-port` 放进 base64 的 `CEFCommandLine` 数组（`WyIt...`）。

两次都没有监听端口；只有扩展目录放 `.debug` 时，引擎才：

```text
DevTools listening on ws://127.0.0.1:39502/...
```

说明 CEP 只从 `.debug` 或自身 `CefSettings` 取端口，不认外部追加的参数。

### 2.4 “启动器 + 入口 shellcode”失败

尝试替换启动器：`CreateProcess(CREATE_SUSPENDED)`，把挂起线程的 `Rip` 改到一段
`LoadLibraryW(hook); jmp entry` 的 shellcode。

实测 DLL 的 `DllMain` 能执行，但随后进程崩溃/挂起（`0xC0000409`）。原因：
`CREATE_SUSPENDED` 时线程还在 **loader 初始化阶段**，`GetThreadContext().Rip` 不是 PE 入口；
直接跳过去会绕过 CRT/loader 初始化。正确做法是：

- 用调试器在 PE 入口下断点（`DEBUG_PROCESS`），到达入口后再注入；或
- 让加载器自然加载一个代理 DLL（本产品采用）。

### 2.5 正确做法：加载器阶段代理

`VCRUNTIME140_1.dll` 是 `CEPHtmlEngine.exe` 的静态导入，Windows 会在入口前加载它。
代理在 `DllMain` 起线程等 `libcef.dll`，patch `cef_initialize` 的 IAT，设置端口：

```text
proxy DllMain pid=468 port=40068
IAT patched real=00007FF9A46A1240
cef_initialize size=464 port=40068
DevTools listening on ws://127.0.0.1:40068/...
```

无需 `.debug`、无需注入、无需改扩展；一次安装，所有面板生效。
详见 [代理证据](proxy-bootstrap-evidence.md)。

## 3. 如果一定要“运行期注入”

理论上可以：

1. **调试器方式**：监控进程创建 → `DebugActiveProcess` → 在入口断点 → 注入 DLL / 改 IAT；
   可不改磁盘文件、可无管理员（同用户），但实现复杂、易被杀软拦截。
2. **Hook 宿主 `CreateProcessW`**：向 AE/PS/AI/PR 注入一个小 DLL，拦截 `CEPHtmlEngine.exe`
   创建，改为 `CREATE_SUSPENDED` + 注入 hook DLL 再恢复；同样复杂。
3. **Hook `cef_browser_host_create_browser`**：如果能在浏览器创建前注入，可以包装 `cef_client_t`
   的 `on_after_created`，拿到 `cef_browser_t` 后直接 `cef_frame_execute_javascript`，
   完全不需要端口；但仍是晚注入竞态。

产品化优先顺序：**代理 DLL（稳定、一次安装） > `.debug`（官方、零二进制） > 调试器/注入（研究）**。

## 4. 研究代码

- `tools/bootstrap/research/launcher.c`：`CREATE_SUSPENDED` + shellcode 启动器（未采用）；
- `tools/bootstrap/research/hook.c`：IAT hook + 端口设置 DLL（远程注入实验）；
- `tools/bootstrap/src/proxy.c`：最终代理（采用）。
