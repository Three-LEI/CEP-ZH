# 代理 DLL 引导实验证据（无 .debug）

> 目标：证明不依赖每个扩展的 `.debug`、也不修改扩展代码时，仍能让任意 CEP 面板获得 CDP 调试端口。
> 方法：在 `CEPHtmlEngine` 目录放一个代理 `VCRUNTIME140_1.dll`，它在 `cef_initialize()` 调用前把
> `cef_settings_t.remote_debugging_port`（CEF 99 偏移 372）改成分配到的端口。

## 1. 代理文件

| 项 | 值 |
| --- | --- |
| 文件 | `tools/bootstrap/dist/VCRUNTIME140_1.dll` |
| 大小 | 5632 字节 |
| SHA256 | `A037B0F42BA8B8B950D9AA1C1609878450D6035AEAEEB41AD2A85C0306194396` |
| 源码 | `tools/bootstrap/src/proxy.c` |
| 导出 | `__CxxFrameHandler4`（转发到 System32 原 DLL） |
| 标记字符串 | `cep-zh CEP engine proxy` |

代理在浏览器进程的 `DllMain` 里启动线程，等待 `libcef.dll` 加载后：

1. 解析 `CEPHtmlEngine.exe` 的导入表，找到 `cef_initialize` 的 IAT 项；
2. `VirtualProtect` + 写入自己的 wrapper；
3. wrapper 在调用原函数前写 `settings + 372`（`int remote_debugging_port`）；
4. 端口来自 `CEP_ZH_PORT` 环境变量，未设置时用 `39600 + PID % 500`；
   并用 `Local\CEPZH_PORT_<port>` 命名互斥量抢占，避免两个引擎/PID 撞同一端口
   （实测 AE 的 Flow 与 Localizer 曾因 PID 哈希撞到 39748，Flow 拿不到端口、Agent 无法注入）。

## 2. After Effects 2026（真实宿主）

安装位置：

```text
D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine\VCRUNTIME140_1.dll
```

启动 AE（**没有任何扩展 `.debug` 文件被创建或修改**）后：

```text
cep-zh status --json
  enabledFiles: 0
  live: 7 个面板
    39724  MYFX localServer
    39808  AE Localizer Bridge
    39816  Flow
    39828  杂鱼-蓝宝石&BCC汉化
    39912  CEP ZH Test
    39988  Overlord
    40068  Overlord
```

代理日志（`%TEMP%\cepzh-proxy.log`）：

```text
proxy DllMain pid=14228 port=39828
IAT patched real=00007FF936911240
cef_initialize size=464 port=39828

proxy DllMain pid=24812 port=39912
IAT patched real=00007FF936911240
cef_initialize size=464 port=39912
```

CEPHtmlEngine 日志同时出现：

```text
WARN  No debug port file found.
DevTools listening on ws://127.0.0.1:39912/devtools/browser/...
```

即引擎明确报告“没有找到 `.debug` 文件”，但仍然监听了代理设置的端口。

Agent 注入结果：

```text
[inject] :39912  cep.zh.test.panel  dict=cep.zh.test.json  changed=13
[inject] :39816  com.rendertom.flow  dict=com.rendertom.flow.json  changed=9
[inject] :39988  com.overlord.panel  dict=Overlord.json  changed=9
```

截图：`docs/screenshots/04-proxy-ae-test-zh.png`（测试面板已全中文，动态帧数也正常）。

## 3. Illustrator 2026（真实宿主）

安装位置：

```text
D:\Adobe\Adobe Illustrator 2026\Support Files\Contents\Windows\CEPHtmlEngine\VCRUNTIME140_1.dll
```

启动 AI 后新增端口：

```text
39612 -> index.html
file:///D:/Adobe/Adobe%20Illustrator%202026/Support%20Files/Required/CEP/extensions/com.adobe.illustrator.OnBoarding/index.html
```

代理日志：

```text
proxy DllMain pid=3512 port=39612
IAT patched real=00007FF8EA691240
cef_initialize size=464 port=39612
```

## 4. Photoshop 2026 / Premiere Pro 2026（引擎级验证）

PS 2026 没有自动打开 CEP 面板，所以用其自带的 `CEPHtmlEngine.exe` 手工启动一个测试面板
（宿主用一个隐藏的 `cmd` 进程，不依赖宿主 UI）：

```text
PS: D:\Adobe\Adobe Photoshop 2026\Required\CEP\CEPHtmlEngine\CEPHtmlEngine.exe
    proxy DllMain pid=20192 port=39792
    cef_initialize size=464 port=39792
    /json -> manual.probe

PR: D:\Adobe\Adobe Premiere Pro 2026\CEPHtmlEngine\CEPHtmlEngine.exe
    proxy DllMain pid=4424 port=40024
    cef_initialize size=464 port=40024
    /json -> manual.probe
```

说明同一代理对四个应用的 CEP 引擎二进制都有效；PS/PR 的 CEP 面板没有在本次自动打开，
但引擎层已验证。

## 5. 安装器验证

`tools/bootstrap/install-proxy.ps1` 在临时引擎副本上验证：

```text
[dry] install ...\dist\VCRUNTIME140_1.dll -> ...\cef-proxy\CEPHtmlEngine\VCRUNTIME140_1.dll
install complete
uninstall complete
```

安装时自动把已有文件备份为 `VCRUNTIME140_1.dll.cepzh-orig`，卸载时恢复。

## 6. 结论与限制

- **`.debug` 不是硬性要求**：只要能在 `cef_initialize()` 之前进入引擎进程，就能直接设置调试端口。
- 代理 DLL 是**一次安装、全扩展生效**的引导方式；不再需要每个扩展写 `.debug`，也不需要重启每个扩展。
- 仍是一次性**二进制修改**：写入 `CEPHtmlEngine` 目录，通常需要管理员权限；Adobe 升级可能覆盖，需要重装。
- 只对**静态导入 `VCRUNTIME140_1.dll` 且 CEF 99 布局**的 CEP 引擎有效（本机 CEP 12 实测有效）。
  CEP 11/9（CEF 88/61）的 `cef_settings_t` 偏移可能不同，不能直接套用，需另做代理或回退 `.debug`。
- 代理会给每个面板开一个 localhost 调试端口，安全风险与 `.debug` 相同；端口只在面板运行时存在。
- 端口分配用命名互斥量占位，避免 PID 哈希碰撞导致某个面板没有端口；非 CEP 程序占用同名端口仍可能冲突，
  可改用 `GetTcpTable` 做真实占用检测（后续优化）。
- 该方法依赖 CEF 99 的 `cef_settings_t` 布局（`remote_debugging_port` 偏移 372）；CEF 大版本升级需要重新核对偏移。
