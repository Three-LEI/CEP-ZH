# 隐藏 Agent 自动启停实验证据

> 目标：验证 CEP 扩展能随 Adobe 宿主启动，自动拉起 cep-zh Agent，并在宿主退出时退出。
> 本实验使用外部 Node 原型（正式版应改为 CEP 内置 Node/浏览器混合，见产品架构）。

## 1. 扩展结构

`product/cep.zh.manager` 的 manifest 包含两个 extension：

```xml
<Extension Id="cep.zh.manager.panel" Version="0.2.0" />
<Extension Id="cep.zh.agent" Version="0.2.0" />
```

`cep.zh.agent`：

- `AutoVisible=false`，`Type=Custom`，1×1；
- `--enable-nodejs --mixed-context`；
- `StartOn`：`ApplicationInitialized` / `applicationActivate`；
- `MainPath=./agent.html`，由 `js/agent.js` 读取配置并 `spawn` Agent。

## 2. 配置

`%APPDATA%\CEP-ZH\config.json`：

```json
{
  "nodePath": "C:\\Users\\LEI\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  "agentScript": "F:\\DSH Workspace\\Adobe通用CEP注入汉化\\tools\\cep-zh\\agent.mjs",
  "extraArgs": ["--verbose"]
}
```

隐藏面板读取 `process.ppid` 作为宿主 PID，执行：

```text
node.exe "...\tools\cep-zh\agent.mjs" --verbose --host-pid 25876
```

## 3. 启动

启动 AE 后，无需手动操作：

```text
%APPDATA%\CEP-ZH\agent\agent.log
2026-11-22T06:33:16.293Z spawned child=17516 host=25876 node=...node.exe

%APPDATA%\CEP-ZH\agent\status-25876.json
{
  "state": "running",
  "hostPid": 25876,
  "childPid": 17516,
  "node": "...node.exe",
  "script": "...agent.mjs",
  "startedAt": "2026-11-22T06:33:16.292Z",
  "updatedAt": "2026-11-22T06:33:36.331Z"
}
```

进程列表：

```text
node.exe 17516  PPID 14724
"C:\Users\LEI\...\node.exe" "...\tools\cep-zh\agent.mjs" --verbose --host-pid 25876
```

此时 CEP 面板（无 `.debug`，代理提供端口）已被自动注入：

```text
39656 CEP ZH Test       -> h1 "汉化测试面板"，stats { changed:75, mutations:64 }
39928 Flow              -> "有可用更新…应用…默认"，stats { changed:9 }
39976 CEP-ZH Agent      （隐藏面板自身）
```

## 4. 停止

在 AE 中执行 `app.quit()`，AE/CEPHtmlEngine 全部退出后：

```text
agent node 17516: False

status-25876.json
  "state": "exited",
  "exitCode": null,
  "signal": "SIGTERM",
  "exitedAt": "2026-11-22T06:33:58.655Z"
```

说明隐藏面板关闭时 `beforeunload` 杀掉了子进程，没有孤儿 Node。

## 5. 结论与限制

- **随宿主启动/停止已跑通**（隐藏 CEP 扩展 + Node spawn）。
- 目前 Agent 是**外部 Node**：需要在配置中指定 `nodePath`；正式产品应改为
  CEP 内置 Node + 浏览器 WebSocket 的混合实现，避免用户安装 Node。
- 隐藏 Agent 当前会处理**所有** CEP 面板，尚未按 `--host-pid` 过滤；多应用同时运行时会重复注入。
  正式版应按父进程 PID 过滤（设计见产品架构第 4 节）。
- 管理器面板 `AutoVisible=true`（CEP 的可见面板；`false` 会出现“有 tab、无内容”的空白面板），
  只从 `窗口 > 扩展 > CEP 汉化管理` 打开；隐藏 Agent 仍是 `AutoVisible=false`。

## 6. 复现

1. 安装代理：`tools\bootstrap\install-proxy.cmd`；
2. 复制 `product\cep.zh.manager` 到 `%APPDATA%\Adobe\CEP\extensions\cep.zh.manager`；
3. 写 `%APPDATA%\CEP-ZH\config.json`（nodePath/agentScript）；
4. 重启 AE；
5. 查看 `%APPDATA%\CEP-ZH\agent\status-*.json` / `agent.log`。
