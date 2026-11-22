# 本地端到端测试记录（安装 → 自动启动 → 热更新 → 卸载）

> 测试日期：2026-11-22  
> 环境：Windows 11，非管理员会话，Adobe 安装在 `D:\Adobe` / `D:\PR25`，系统 Node `C:\Program Files\nodejs\node.exe` v18.19.0  
> 范围：安装脚本、代理、CEP 扩展、隐藏 Agent、Manager、字典热更新、运行时开关、卸载。  
> **未制作安装包**（按要求先完成本地测试）。

## 1. 安装脚本

`installer/install.ps1`：

- 自动扫描 `D:\Adobe`、`C:\Program Files\Adobe`、`Program Files (x86)` 以及注册表 `InstallLocation`；
- 只处理 `CEPHtmlEngine` 主版本 ≥ 12 的引擎；
- 备份已有 `VCRUNTIME140_1.dll` 为 `.cepzh-orig`；
- 安装 6 个引擎：

```text
D:\Adobe\Adobe After Effects 2025\Support Files\CEPHtmlEngine
D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine
D:\Adobe\Adobe Illustrator 2026\Support Files\Contents\Windows\CEPHtmlEngine
D:\Adobe\Adobe Photoshop 2026\Required\CEP\CEPHtmlEngine
D:\Adobe\Adobe Premiere Pro 2026\CEPHtmlEngine
D:\PR25\Adobe Premiere Pro 2025\CEPHtmlEngine
```

非管理员会话下全部可写（`D:\` 安装），安装成功；`C:\Program Files` 下的 CEP 9/11 引擎被跳过。
同时安装：

```text
%APPDATA%\Adobe\CEP\extensions\cep.zh.manager       # CEP 面板
%LOCALAPPDATA%\CEP-ZH\agent\tools\cep-zh            # Agent 文件
%APPDATA%\CEP-ZH\config.json                        # nodePath / agentScript
%LOCALAPPDATA%\CEP-ZH\install.json                  # 安装清单
HKCU\...\Uninstall\CEP-ZH                          # 卸载入口（免管理员）
```

## 2. 启动 After Effects

AE 2026 启动后：

```text
CEP 进程：48
代理端口：9 个（39604 / 39692 / 39708 / 39728 / 39796 / 39844 / 39932 / 40012 / 8669）
隐藏 Agent：node.exe 13416，父进程为 CEP 引擎
  "...\node.exe" "...\CEP-ZH\agent\tools\cep-zh\agent.mjs" --verbose --host-pid 17764
状态：%APPDATA%\CEP-ZH\agent\status-17764.json state=running
```

Flow 面板自动注入：

```json
{
  "stats": { "changed": 9, "textNodes": 9, "observedRoots": 1 },
  "text": "有可用更新…应用…默认…"
}
```

Manager 面板显示 3 个插件字典，状态页能读到 Agent：

```text
Agent:
  status-17764.json  state=running child=13416 host=17764
```

## 3. Manager 字典保存

在 Manager 的“公共字典”页写入 `InstallerTest=安装测试` 并点击保存：

```text
{"status":"公共字典已保存","has":true}
%APPDATA%\CEP-ZH\dict\global.json  →  "InstallerTest": "安装测试"
```

说明面板的 `cep.fs` 读写链路正常。

## 4. 热更新

修改 `%APPDATA%\CEP-ZH\dict\extensions\com.rendertom.flow.json`：

```json
{ "strings": { "linear": "线性" } }
```

约 2 秒后 Flow 面板出现“线性”；删除后恢复 `linear`。Agent 日志：

```text
[dict] watching C:\...\tools\cep-zh\dict
[dict] watching C:\Users\LEI\AppData\Roaming\CEP-ZH\dict
[dict] reloaded
[inject] :39692 re-injected after dictionary change
```

## 5. 实时关闭/恢复

对 Flow 执行 `window.__CEP_ZH__.off()`：

```text
text: "Update AvailableDetails…Remind Me…"
stats: { enabled:false, textNodes:0 }
```

执行 `window.__CEP_ZH__.enable()`：

```text
text: "有可用更新详情…稍后提醒…应用…默认…"
stats: { enabled:true, textNodes:9 }
```

说明运行时级实时开关可用；目前还没有接到 Manager 的总开关 UI。

## 6. 卸载

`install.ps1 -Uninstall`（非管理员）：

```text
removed: 6 个引擎代理
removed extension: ...cep.zh.manager
removed extension backup: ...cep.zh.manager.cepzh-backup
removed agent: ...\CEP-ZH\agent
removed data: ...\CEP-ZH
```

结果：

```text
proxies=0
extension=False  backup=False
agent=False      data=False
manifest=False   registry=False
```

## 7. 本轮发现并修复的问题

| 问题 | 修复 |
| --- | --- |
| 系统 Node 18 没有全局 `WebSocket`，Agent 不注入 | 新增 `lib/ws.mjs` 最小 RFC6455 客户端，Node 18/22+ 都可用 |
| Manager 写 `%APPDATA%\CEP-ZH\dict`，Agent 只看安装目录的 `dict` | `dictionaryRoots()` 同时加载 bundled + user 字典并监听两者，user 覆盖 bundled |
| 重复安装后 `.cepzh-backup` 残留 | 卸载时清理扩展备份 |
| PowerShell 5.1 读取无 BOM 的 UTF-8 中文脚本失败 | `install.ps1` 使用 UTF-8 BOM |
| 非管理员无法写 HKLM 卸载项 | 改用 HKCU 卸载入口；Program Files 引擎跳过并提示 |
| 安装脚本强制要求管理员 | 改为“能写就装、不能写跳过”，D:\Adobe 自定义安装可免管理员 |
| **Manager 面板空白（DOM 有内容、宿主不显示）** | Manager 的 `AutoVisible` 是 `false` 时，CEP 只建了 tab，内嵌 CEPHtmlEngine 窗口没有显示；改为 `AutoVisible=true` 后正常渲染（Agent 仍保持 false） |
| **Flow 等个别面板拿不到端口、不汉化** | 代理用 `39600 + PID%500` 会撞端口（实测 Flow 与 AE Localizer 都落到 39748）；新增 `Local\CEPZH_PORT_<port>` 命名互斥量占位，8 个浏览器进程现在端口唯一 |

## 8. 仍未完成的本地测试

- Manager 面板在 PS/AI/PR 里的实际菜单位置与布局（本轮只在 AE 测了 Manager；AI 只验证了代理端口）；
- 真实翻译 API（目前只测了 mock；需要 Key）；面板里的 AI 翻译仍是占位按钮；
- 多 Adobe 应用同时运行时的 Agent 按宿主 PID 过滤（当前会处理所有面板）；
- 安装包（Inno Setup/WiX）——按要求暂不制作。

## 9. Manager v2 / 自动捕获（本轮新增验证）

| 项目 | 结果 |
| --- | --- |
| 新管理面板 | 表格编辑、搜索、状态筛选、分页、未翻译优先排序 |
| 主题 | 默认亮色；右上角 LIGHT/DARK 切换；暗色降低对比度 |
| 点线面 UI | 点阵/细线/几何轮廓、署名 `three-lei × deepseek`、版本 `v0.2.0`；移除左上角图标 |
| MiSans 字体 | 官方 Regular/Medium WOFF2 嵌入，`document.fonts.check('12px MiSans')=true`；设置页注明许可 |
| 界面缩放 | 字号由 `clamp()` + rem 自动跟随面板/系统缩放；窄/矮面板切紧凑布局，无手动缩放控件 |
| 关于页 | GitHub 地址 + 打开按钮；哔哩哔哩仅显示跳转按钮，不显示网址 |
| 搜索分离 | 左侧 `pluginSearch` 只筛插件；表格 `dictSearch` 只筛原文/译文；公共字典使用独立 `globalDictSearch` |
| 捕获过滤 | `isTranslatable` 跳过纯中文、纯数字、纯符号；`× / ÷ / ...` 均不捕获 |
| AI 翻译 | mock 当前插件：翻译 28、跳过 9；全部字典：翻译 1290、跳过 62；完成后按钮恢复 |
| 导出 / 导入 | 导出 12 个插件 JSON 到 `CEP-ZH-dict-时间` 文件夹；从该文件夹导入 12 个文件 / 50 条译文 |
| 开关速度 | 全局关闭→Flow `enabled=false` **65 ms**；重新开启 **59 ms**（`fs.watch` + 并行 CDP） |
| 自动捕获 | Agent 启动后 6 个第三方面板自动写入字典；Flow 37 条，其中 28 条 easing 未翻译 |
| 自身排除 | Agent 跳过 `cep.zh.manager` / `cep.zh.agent`，编辑器界面不再被自己翻译 |
| 表格编辑 | `linear` 填“线性”后 2 秒内 Flow 显示“线性”；清空后回退英文 |
| 全局开关 | `control.json enabled=false` → Flow `stats.enabled=false`，文本恢复英文；再开恢复中文 |
| 单插件开关 | 只把 Flow 加入 `disabledPlugins`，Flow 英文、Overlord 中文 |
| 手动捕获 | 删除 Flow 的 `linear` 后点“捕获已打开插件”，`lastCollect.added=1`，条目自动补回 |
| 重载自动捕获 | 删除 `linear` 后 `location.reload()` Flow，约 2 秒后 Agent 自动补回空条目 |
| 优先级回退 | 清空 Flow 的 `APPLY` 用户译文，仍显示内置“应用”；表格显示“内置”，不会覆盖底层字典 |
| 面板尺寸 | AE 把面板停靠到 516×350 时自动切紧凑布局；表格仍可编辑，拉大后显示更多行 |

截图：

- [亮色（默认）](screenshots/10-manager-pointline-light.png)
- [暗色（低对比）](screenshots/11-manager-pointline-dark.png)
- [搜索分离](screenshots/12-manager-split-search.png)
- [导出 / 导入](screenshots/13-manager-export.png)
- [关于](screenshots/15-manager-about.png)

已确认的边界：管理面板不会翻译自己；AI 翻译按钮只占位；面板很小的时候只显示 2–3 行，
需要拖动放大或浮动面板。
