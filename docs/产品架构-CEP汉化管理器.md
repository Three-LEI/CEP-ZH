# CEP 汉化产品架构：cep-zh Manager

> 目标：面向 After Effects / Premiere Pro / Photoshop / Illustrator 等所有 CEP 宿主，
> 一次安装、随宿主自动启停、宿主内有管理菜单、公共字典 + 插件字典 + 翻译 API，
> 用户不需要逐个扩展配置。

---

## 1. 结论先行

- **`.debug` 不是硬性要求。** 它是“不修改任何二进制”时最干净的官方通道，但代价是
  每个扩展一个文件、系统目录需要管理员、升级可能被删。
- **代理 DLL 已验证可行**：在 `CEPHtmlEngine` 目录放一个 `VCRUNTIME140_1.dll` 代理，
  在 `cef_initialize()` 前设置调试端口。一次安装后，**所有扩展、所有新面板自动可用**，
  不再写 `.debug`。AE/AI 真实宿主、PS/PR 引擎二进制均已验证（见
  [代理 DLL 证据](proxy-bootstrap-evidence.md)）。
- 代理仍然是一次性的二进制安装（通常需要管理员），但它是**按应用安装一次**，不是按扩展；
  这是“免管理员”和“稳定性”之间目前最好的折中。
- 产品由三部分组成：
  1. **Bootstrap**：CEP 引擎代理（或无管理员时的 `.debug` 回退）；
  2. **Agent**：随宿主启动的隐藏 CEP 扩展，发现面板、注入运行时、热更新字典；
  3. **Manager**：宿主内可见 CEP 面板，管理公共字典/插件字典/翻译 API。

---

## 2. 总体结构

```
┌──────────────────────────── Adobe 宿主（AE/PR/PS/AI…） ────────────────────────────┐
│                                                                                   │
│  ┌──────────────┐   启动时加载     ┌──────────────────────────────┐               │
│  │ CEP 引擎代理  │ ──────────────> │ CEPHtmlEngine.exe (每个面板)  │               │
│  │ VCRUNTIME140_1│  cef_initialize │  browser + renderer + gpu    │               │
│  │ .dll          │  设置调试端口    │  file:///.../panel/index.html│               │
│  └──────────────┘                  └──────────────┬───────────────┘               │
│                                                    │ CDP (127.0.0.1:39600+)        │
│  ┌──────────────────────┐   本地 HTTP/文件        │                              │
│  │ 隐藏 CEP 扩展         │ <───────────────────────┘                              │
│  │ cep.zh.agent         │  发现端口 → 注入 runtime.js → 监听字典                    │
│  │ (StartOn 自动启动)    │                                                         │
│  └──────────┬───────────┘                                                         │
│             │ 读写 %APPDATA%\CEP-ZH                                                │
│  ┌──────────▼───────────┐                                                         │
│  │ 可见 CEP 面板         │  Window > Extensions > CEP 汉化管理                      │
│  │ cep.zh.manager       │  公共字典 / 插件字典 / API Key / 状态                     │
│  └──────────────────────┘                                                         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

跨应用共享：`%APPDATA%\CEP-ZH\` 下的字典、配置、缓存；每个宿主进程启动自己的 Agent。

---

## 3. Bootstrap：为什么选代理 DLL

| 方案 | 免 `.debug` | 免逐扩展管理员 | 免二进制修改 | 稳定性 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `.debug`（现有） | ❌ | ❌ | ✅ | 官方支持，最稳 | **回退/无管理员用户** |
| `CEPHtmlEngine` 启动器追加参数 | ✅ | ✅（每应用一次） | ❌ | 参数无效（实测 raw flag 不生效） | 否 |
| 远程线程注入 + hook `cef_initialize` | ✅ | ✅ | ✅ | 注入晚于 CEF 初始化，竞态 | 研究用 |
| **代理 `VCRUNTIME140_1.dll`** | ✅ | ✅ | ❌（每应用一次） | 实测稳定，loader 保证早于入口 | **主方案** |
| 代理 `libcef.dll` | ✅ | ✅ | ❌ | 导出转发复杂 | 不采用 |

### 3.1 代理的工作原理

1. `CEPHtmlEngine.exe` 静态导入 `VCRUNTIME140_1.dll`（本机 CEP 12 的 4 个应用均如此）；
2. 把代理放在引擎目录，Windows 加载器优先加载应用目录的同名 DLL；
3. 代理导出 `__CxxFrameHandler4`（转发到 System32 原 DLL），保证 C++ 异常展开不受影响；
4. `DllMain` 起线程等待 `libcef.dll`，解析主程序导入表，把 `cef_initialize` 的 IAT 指向 wrapper；
5. wrapper 写 `cef_settings_t.remote_debugging_port`（CEF 99 偏移 372），再调用原函数；
6. 每个面板进程获得独立端口（`39600 + PID % 500`，可被 `CEP_ZH_PORT` 覆盖）。

### 3.2 安装位置

每个应用的 `CEPHtmlEngine.exe` 目录放一个 5 KB 的 `VCRUNTIME140_1.dll`：

```text
D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine\
D:\Adobe\Adobe Illustrator 2026\Support Files\Contents\Windows\CEPHtmlEngine\
D:\Adobe\Adobe Premiere Pro 2026\CEPHtmlEngine\
D:\Adobe\Adobe Photoshop 2026\Required\CEP\CEPHtmlEngine\
```

安装器：`tools/bootstrap/install-proxy.ps1`（带备份、`-Uninstall`、`-DryRun`、`-Elevate`）。

### 3.3 兼容性

- 已验证：**CEP 12 / CEF 99** 的 AE 2026、AI 2026、PS 2026、PR 2026 引擎二进制；
- AE 2025 也是 CEP 12，安装器会处理，但未做真实面板回归；
- **CEP 11 / 9 不能直接复用**：CEF 88/61 的 `cef_settings_t` 布局可能不同，偏移 372 不保证正确；
  安装器默认只处理 CEP 12，旧版回退 `.debug` 或另做对应版本的代理；
- Adobe 升级可能覆盖代理，安装器/启动器应检测并提示重装。

---

## 4. Agent：随宿主自动启停

### 4.1 扩展形态

同一个 bundle（`cep.zh`）包含两个扩展：

```xml
<Extension Id="cep.zh.agent">      <!-- 隐藏，StartOn 自动启动 -->
  <MainPath>./agent.html</MainPath>
  <CEFCommandLine>
    <Parameter>--enable-nodejs</Parameter>
    <Parameter>--mixed-context</Parameter>
  </CEFCommandLine>
  <AutoVisible>false</AutoVisible>
  <StartOn>
    <Event>ApplicationInitialized</Event>
    <Event>applicationActivate</Event>
  </StartOn>
  <UI><Type>Custom</Type>…</UI>
</Extension>
<Extension Id="cep.zh.manager">    <!-- 可见，Window > Extensions -->
  <MainPath>./index.html</MainPath>
  <AutoVisible>true</AutoVisible>
  <Menu>CEP 汉化管理</Menu>
</Extension>
```

> 注意：CEP `Panel` 如果 `AutoVisible=false`，从菜单打开时可能只创建一个空白 tab（内嵌 CEPHtmlEngine
> 窗口不显示），DOM 实际已加载。Manager 必须 `AutoVisible=true`；隐藏 Agent 保持 `false`。

### 4.2 启动/停止

- `StartOn` 让隐藏扩展随宿主启动；CEP 会拉起一个隐藏的 `CEPHtmlEngine`；
- Agent 只处理 **父进程 PID = 本宿主 PID** 的 CEP 引擎，避免多应用互相干扰；
- Agent 监听 `ApplicationActivate`/`ApplicationDeactivate`，可在宿主失焦时暂停；
- 宿主退出时 CEP 销毁引擎，Node 子进程通过父进程管道/心跳检测退出，避免孤儿；
- 多个 Adobe 应用同时运行时，每个宿主一个 Agent，各自管理自己的面板；
- 管理器通过 `%APPDATA%\CEP-ZH\state.json` 读取 Agent 状态，通过 `control.json` 下发
  全局启用/单插件停用/捕获 token/AI 翻译任务，轮询间隔 1–2 秒。

### 4.3 实现选择：零外部 Node

推荐最终形态是 **Node 上下文只做进程/端口/文件，浏览器上下文做 CDP**：

- Node 侧：`tasklist`/`netstat` 发现 `CEPHtmlEngine.exe` 子进程和端口；读写字典；
- 浏览器侧：原生 `WebSocket` 连接 CDP，`Runtime.evaluate` / `Page.addScriptToEvaluateOnNewDocument`；
- 这样不依赖用户安装 Node，也不需要在 CEP 里打包 `ws`。

当前原型（`tools/cep-zh/agent.mjs`）是外部 Node 版本，用于验证；产品化时按上述拆分。

---

## 5. Manager：宿主内管理菜单

### 5.1 菜单

- CEP 支持的是 **`窗口 > 扩展 > <Menu>`**；本产品菜单名 `CEP 汉化管理`；
- 已在 AE 2026 实测：通过 `app.findMenuCommandId('CEP 汉化管理')` 打开面板；
- 面板自身还可以用 `setPanelFlyoutMenu` 增加“立即扫描 / 重新注入 / 打开字典目录”等快捷项；
- **原生顶级菜单**（如 AE 菜单栏的“汉化”）需要各应用原生插件（AEGP/PS SDK/AI SDK/PR SDK），
  不能用一个 CEP 扩展跨应用实现。建议 v1 不做；如果必须，按应用单独做薄插件，调用同一个 Agent。

### 5.2 界面

`product/cep.zh.manager` 已实现：

- **点线面极简界面**：点阵/细线/几何轮廓背景，无渐变玻璃；默认亮色，另提供低对比暗色；
- **字体与缩放**：内嵌官方 MiSans Regular/Medium WOFF2（设置页注明许可）；
  字号用 `clamp()` + rem 自动跟随面板/系统缩放，窄/矮面板自动紧凑；
- **快速开关**：Agent 用 `fs.watch` 监听 `control.json`，并行对所有面板执行 off/on，
  实测全局切换约 60 ms；
- **虚拟编辑表**：原文 / 译文 / 状态 / 删除，按未翻译优先排序，支持搜索、状态筛选、分页；
- **实时开关**：全局“汉化 / 恢复原文”、单插件开关，Agent 1–2 秒内响应；
- **自动捕获**：Agent 在面板打开/重载时提取文本与属性，合并进插件字典；
  纯中文、纯数字、纯符号会被过滤；未翻译条目显示“未翻译”，用户直接填写；
- **AI 翻译**：当前插件 / 全部字典两个入口，只翻译空译文、跳过已有译文；
  支持 OpenAI 兼容、DeepL、mock 测试；
- **导出 / 导入**：可勾选一个或多个插件导出到新文件夹；选择文件夹批量导入，
  自动识别插件 JSON 与 `global.json`；
- **优先级**：插件字典（用户覆盖 > 内置）> 公共字典；空译文自动回退公共字典；
- **手动捕获**：“捕获已打开插件”请求 Agent 重新扫描，只补缺失词条，不覆盖已有翻译；
- **05 关于**：项目信息、GitHub 地址与打开按钮、哔哩哔哩跳转按钮；
  GitHub 地址与打开按钮、哔哩哔哩跳转按钮；

存储：

```text
%APPDATA%\CEP-ZH\
  dict\
    global.json
    extensions\
      com.rendertom.flow.json
      Overlord.json
      cep.zh.test.json
  config.json          # 翻译 API/语言/日志级别（API Key 只在本地）
  control.json         # { enabled, disabledPlugins, collectToken, translationTask }
  state.json           # Agent 写入：面板/端口/注入状态/最近捕获/翻译进度
  agent\<hostPid>.json # Agent 子进程状态
```

面板用 `cep.fs` 直接读写字典，并轮询 `state.json`；保存后 Agent 的文件监听自动热重载。
Agent 不会注入 `cep.zh.manager` / `cep.zh.agent` 自身，避免编辑器界面被自己翻译。

### 5.3 字典模型

三级优先级（高 → 低）：

1. **宿主+插件覆盖**：`extensions/<bundleId>.<HOST>.json`（同一插件在 PS/AE 中不同译法）；
2. **插件字典**：`extensions/<bundleId>.json`；
3. **公共字典**：`global.json`。

结构：

```json
{
  "name": "Flow",
  "strings": {
    "APPLY": "应用",
    "Update Available": "有可用更新"
  },
  "patterns": [
    { "re": "^Frames rendered: (\\d+)$", "to": "已渲染帧数：$1" }
  ]
}
```

规则：

- 纯文本精确匹配优先，其次压缩空白后匹配，最后按 `patterns` 正则；
- 跳过 `script/style/code/pre/svg/canvas/textarea/contenteditable`；
- 属性支持 `title/placeholder/aria-label/aria-placeholder/alt/data-pt-title/tooltip`；
- 支持 iframe（同源）、Shadow DOM、MutationObserver 动态内容；
- 每个词条保留英文原文 + 译文 + 状态（人工/机器/待确认），便于后续校对。

### 5.4 翻译 API

- Provider 抽象：OpenAI 兼容 `/chat/completions`、DeepL；后续可加百度/腾讯/阿里；
- **Key 只存本地**；Manager 不直接把 Key 发给外部页面，由 Agent（Node）代为请求，避免 CORS；
- 批量翻译：按 bundle 分批、只翻未翻译/待确认词条，带缓存（原文 hash + provider + targetLang）；
- 结果先进入“候选”状态，人工确认后写入正式字典；
- 成本控制：显示 token 估算、可中断、可重试、可只翻当前可见面板的 catalog。

已实现的 CLI（`tools/cep-zh/translate.mjs`）：

```bat
node tools\cep-zh\translate.mjs --catalog tools\cep-zh\catalog\com.rendertom.flow.json ^
  --bundle com.rendertom.flow --provider openai
```

- 配置从 `%APPDATA%\CEP-ZH\config.json` 读取（Manager 的“翻译 API”页会写）；
- 支持 `openai`（OpenAI/DeepSeek 兼容）、`deepl`、`mock`；
- 先用 `--provider mock` 验证链路，再换成真实 Key；
- 结果写 `.auto.json`，检查后 `--write` 合并进正式字典，Agent 热重载。

典型流程：

1. 打开插件 → Agent 注入 runtime，未命中字符串进入 `catalog/<bundleId>.json`；
2. Manager “采集当前插件” → 读取 catalog；
3. 选中待翻译 → “机器翻译” → Agent 调 API → 候选写入；
4. 人工校对 → 保存 → Agent 热重载 → 面板即时更新。

---

## 6. 生命周期与端口

- 代理给每个面板分配 `39600 + PID % 500` 的端口；Agent 用 `netstat`/`tasklist` 发现，
  也可读 `%TEMP%\cepzh-proxy.log`；
- 端口只绑定 `127.0.0.1`，面板关闭即释放；
- Agent 每 2 秒扫描新端口，对 URL→bundle 做最长前缀匹配（防止多个开发者 `.debug` 共用端口）；
- Manager/Agent 用 `%APPDATA%\CEP-ZH\agent\<hostPid>.json` 交换 `{port, token, startedAt}`；
- 宿主退出：Agent 退出；管理器隐藏；代理 DLL 留在磁盘，下次启动继续生效。

---

## 7. 安装、升级、卸载

### 7.1 用户视角

1. 运行 `install-proxy.cmd`（一次 UAC）→ 给检测到的 Adobe 应用安装代理；
2. 把 `cep.zh.manager` 复制到 `%APPDATA%\Adobe\CEP\extensions\`（无需管理员）；
3. 重启 Adobe 应用；
4. 打开 `窗口 > 扩展 > CEP 汉化管理`，编辑字典/API；
5. Agent 随宿主自动运行，面板自动汉化。

### 7.2 升级

- 代理：安装器可重复运行；检测已有代理版本/hash，覆盖并保留备份；
- Manager/Agent：用户目录扩展直接覆盖，重启宿主；
- Adobe 应用升级后：安装器重新扫描并提示“代理已被覆盖”；
- 字典/配置独立于版本，升级不丢。

### 7.3 卸载

- `install-proxy.ps1 -Uninstall`：恢复 `VCRUNTIME140_1.dll.cepzh-orig` 或删除代理；
- 删除用户目录扩展和 `%APPDATA%\CEP-ZH` 可选；
- 重启应用后不再有调试端口。

---

## 8. 跨应用兼容矩阵

| 应用 | 引擎路径 | 代理验证 | 真实面板验证 | 备注 |
| --- | --- | --- | --- | --- |
| After Effects 2026 | `Support Files\CEPHtmlEngine` | ✅ | ✅ 7 个面板 | 主测试环境 |
| Illustrator 2026 | `Support Files\Contents\Windows\CEPHtmlEngine` | ✅ | ✅ OnBoarding | 自动启动的 CEP 面板 |
| Photoshop 2026 | `Required\CEP\CEPHtmlEngine` | ✅ 引擎级 | ⏳ 无自动 CEP 面板 | 需 PHXS 兼容扩展 |
| Premiere Pro 2026 | `CEPHtmlEngine` | ✅ 引擎级 | ⏳ 需打开 PPRO 面板 | 需 PPRO 兼容扩展 |
| AE 2024/2025 | 各自 `CEPHtmlEngine` | 代理可安装 | 未测 | CEP 11/12 |
| PS 2020 | `Required\CEP\CEPHtmlEngine` | 未测 | 未测 | 可能 CEP 9/10，需回退 |

跨应用注意：

- CEP 版本/Chromium 版本不同：runtime 按 ES5 编写；`Page.addScriptToEvaluateOnNewDocument`
  在旧版可能缺失，Agent 用 `Page.frameNavigated` 兜底；
- 各宿主菜单 ID 不同：Manager 通过自身 CEP 菜单打开，不依赖宿主脚本；
- 扩展的 HostList 决定可见性；Manager/Agent 的 manifest 列全宿主；
- Photoshop 2026 逐步转向 UXP，但 CEP 遗留扩展仍由 CEPHtmlEngine 渲染，代理对引擎生效。

---

## 9. 安全与合规

- 代理修改 Adobe 安装目录：需要管理员，可能触发企业软件完整性检查/杀软；安装器必须提供备份和卸载；
- 调试端口无认证：本机任意进程可执行面板 JS，进而 `evalScript` 调宿主；只在可信机器使用；
- Manager 的 API Key 存本机用户目录，建议用 DPAPI 加密（下一版），不上传 Adobe/第三方；
- Agent 不使用网络端口对外，只连 loopback；不监听 0.0.0.0；
- 翻译内容可能包含项目/插件信息，调用第三方 API 前需用户确认；
- 代码签名：代理/扩展正式发布应签名，减少 SmartScreen/AV 误报。

---

## 10. 原型状态

| 模块 | 状态 | 位置 |
| --- | --- | --- |
| `.debug` + CDP 方案 | ✅ 已验证 | `tools/cep-zh` |
| 代理 `VCRUNTIME140_1.dll` | ✅ AE/AI/PS/PR 引擎验证 | `tools/bootstrap` |
| 代理安装/卸载脚本 | ✅ 本地非管理员安装 6 个引擎、卸载清理验证 | `installer/install.ps1` |
| Manager 面板（点线面 UI） | ✅ 表格编辑、默认亮色/低对比暗色、全局/单插件开关、恢复原文 | `product/cep.zh.manager` |
| MiSans / 缩放 | ✅ 官方 WOFF2 嵌入、许可署名、clamp+rem 自动字号与紧凑布局 | `product/cep.zh.manager/fonts` |
| 关于页 | ✅ 项目信息、GitHub/哔哩哔哩跳转 | `product/cep.zh.manager` |
| 开关响应速度 | ✅ `fs.watch` + 并行 CDP，全局切换约 60 ms（58–65 ms） | `tools/cep-zh/agent.mjs` |
| 自动单词捕获 | ✅ 新面板自动写入插件字典，未翻译优先展示；纯中文/数字/符号过滤 | `tools/cep-zh/agent.mjs` |
| AI 翻译 | ✅ mock 实测当前插件 +28、全部 +1290，跳过已翻译 | `tools/cep-zh/lib/translate-api.mjs` |
| 导出 / 导入 | ✅ 导出 12 个插件字典；从文件夹导入 12 个文件 / 50 条译文 | `product/cep.zh.manager/js/app.js` |
| CLI Agent + runtime | ✅ Flow/Overlord 等面板注入；Node 18 WS 回退 | `tools/cep-zh/agent.mjs`、`lib/ws.mjs` |
| 隐藏 Agent 自动启动 | ✅ AE 启动 Node 18 子进程、6 个第三方面板注入、退出 SIGTERM | `product/cep.zh.manager` + `docs/autostart-evidence.md` |
| 字典热更新 | ✅ 表格编辑后 2 秒内 Flow 生效；恢复空值后回退英文 | `docs/local-e2e-test.md` |
| 实时关闭/恢复 | ✅ 全局和单插件 `off/on` 实测英文/中文切换 | `docs/local-e2e-test.md` |
| 翻译 API 实际调用 | ✅ CLI + mock 链路；真实 Key 待用户配置；面板 AI 按钮占位 | `tools/cep-zh/translate.mjs` |
| 原生顶级菜单 | ⏳ 需按应用插件 | 第 5.1 节 |
| 安装包（exe） | ⏳ 按要求暂不制作 | 第 7 节 |

---

## 11. 路线图

- **M0（已完成）**：代理 + CLI Agent + Manager 面板原型；
- **M1**：隐藏 CEP 扩展内实现 Agent（Node 发现 + 浏览器 CDP），随宿主启停；
- **M2**：Manager 调 Agent 本地 HTTP，完成 catalog/机器翻译/校对/热重载闭环；
- **M3**：安装器 UI、代理版本检测、应用升级后自动修复；
- **M4（可选）**：各应用原生菜单薄插件；PS 2020/CEP 9 的 CRT 代理兼容。

---

## 12. 关键文件

- 代理源码：`tools/bootstrap/src/proxy.c`
- 代理二进制：`tools/bootstrap/dist/VCRUNTIME140_1.dll`
- 安装器：`tools/bootstrap/install-proxy.ps1`
- 实验证据：`docs/proxy-bootstrap-evidence.md`
- Manager 扩展：`product/cep.zh.manager`
- Agent/runtime：`tools/cep-zh`
- 截图：`docs/screenshots/04-proxy-ae-test-zh.png`
