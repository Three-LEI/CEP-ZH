# 低版本 CEP 引擎级汉化引导研究（CEP 9–11）

> 目标：不再给每个扩展写 `.debug`，而是在 `CEPHtmlEngine` 层一次性获得调试端口，
> 让之后安装的 CEP 插件也自动可用。
>
> 测试环境：**Photoshop 2020 21.2.9 / CEP 9.4.0 / CEF 3.3163.1671 / Chromium 61**。
> 测试完成后已恢复原始 `CEPHtmlEngine.exe`。

## 为什么 `.debug` 是每个扩展一个

Adobe CEP 的加载器只从扩展自己的根目录读取 `.debug`：

```text
<extension>/.debug
```

它没有全局注册表项、环境变量或全局 `.debug`。所以“一个 `.debug` 文件覆盖所有插件”
在 CEP 设计上不存在。

真正全局的位置是 `CEPHtmlEngine.exe` 初始化 CEF 时的：

```c
cef_settings_t.remote_debugging_port
```

把这个字段设上，引擎下所有 CEP 面板都有调试端口。

## 路线 A：命令行 `--remote-debugging-port`（失败）

CEF 文档说 `remote_debugging_port` 也可由 `remote-debugging-port` 命令行开关设置。
我用一个最小 launcher 包住真实 `CEPHtmlEngine.exe` 并追加：

```text
--remote-debugging-port=39796
```

结果：**CEPHtmlEngine 直接以退出码 1 结束**；不带该参数时同一 launcher 正常运行，
并启动真实引擎。说明 Adobe 的 CEP 启动参数解析不接受这个额外开关。

## 路线 B：替换 `VCRUNTIME140.dll` 代理（未加载）

CEP 9 的引擎确实静态导入 `VCRUNTIME140.dll`（不是 `VCRUNTIME140_1.dll`）。
我生成过导出转发 DLL，但把它放到引擎目录后：

- 没有代理日志；
- CEP 引擎没有获得端口。

说明本机加载器把 `VCRUNTIME140.dll` 解析到 System32 / KnownDLL，而不是引擎目录中的同名文件。
这条路线在 CEP 9 上不可靠。

## 路线 C：引擎 launcher + 注入 hook（成功）

做法：

1. 把原 `CEPHtmlEngine.exe` 重命名为 `CEPHtmlEngine.real.exe`；
2. 在引擎目录放一个 launcher 作为 `CEPHtmlEngine.exe`；
3. launcher 以挂起方式启动真实引擎；
4. `CreateRemoteThread(LoadLibraryW)` 注入 `cepzh-hook.dll`；
5. hook 在 `libcef.dll` 加载后 patch `cef_initialize` 的 IAT；
6. hook 把 `cef_settings_t.remote_debugging_port` 写入 CEF 3163 的偏移 **316**；
7. launcher 恢复真实引擎，等待退出，把退出码返回给 Adobe 宿主。

实测日志：

```text
DllMain pid=8600 port=39796
IAT patched cef_initialize=00007FFBE0434198
cef_initialize: size=360 port=39796
```

随后：

```text
netstat: TCP 127.0.0.1:39796 LISTENING
GET http://127.0.0.1:39796/json
→ CEP-ZH Agent 页面
```

说明引擎级端口成功建立，且**不需要任何 `.debug`**。

## CEF 版本偏移

| CEP | CEF / Chromium | `cef_settings_t.size` | `remote_debugging_port` offset |
| --- | --- | --- | --- |
| CEP 9 | CEF 3.3163 / Chromium 61 | **360** | **316**（实测） |
| CEP 10 | CEF 74 / Chromium 74 | 待测 | 待测 |
| CEP 11 | CEF 88 系 / Chromium 88 | 待测 | 待测 |
| CEP 12 | CEF 99 / Chromium 99 | **464** | **372**（已用于代理） |

工程里现有两条实现：

- CEP 12 代理：[tools/bootstrap/src/proxy.c](../tools/bootstrap/src/proxy.c)
- CEP 9 原型：[tools/bootstrap/cepzh-launcher.c](../tools/bootstrap/cepzh-launcher.c)、
  [tools/bootstrap/cepzh-hook.c](../tools/bootstrap/cepzh-hook.c)

## 与 `.debug` 的取舍

| 方案 | 新插件自动生效 | 修改 Adobe 引擎 | 风险 |
| --- | --- | --- | --- |
| `.debug` | ❌ 需补写 | 否 | 低，官方机制 |
| CEP 12 代理 | ✅ | 是（一个 DLL） | 中，已验证 |
| CEP 9 launcher + hook | ✅ | 是（重命名 exe + 注入 DLL） | 较高，杀软/更新/完整性 |
| 命令行开关 | — | 是 | 失败，不采用 |

## 建议

1. **CEP 12**：继续用安装器里的引擎代理，新插件自动生效。
2. **CEP 9**：如果接受“修改引擎 + 注入”的风险，可以做成可选实验模式；
   这是目前唯一验证成功的旧版一劳永逸方案。
3. **默认安装**仍建议 `.debug`：官方、可恢复、不碰 Adobe 二进制，适合大多数用户。
4. CEP 10/11 需要补 CEF 74/88 的偏移表并回归；不能直接复用 CEP 9 的 316。

## 复现文件

- `tools/bootstrap/cepzh-launcher.c`：launcher + `CreateRemoteThread` 注入
- `tools/bootstrap/cepzh-hook.c`：IAT hook + CEF9 偏移 316
- `tools/bootstrap/research/proxy_v140.c`：失败路线留档

测试结束后已恢复 PS2020 的 `CEPHtmlEngine.exe` 原文件。
