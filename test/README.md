# 实验/调试脚本

这些脚本是研究过程中使用的辅助工具，不属于 `cep-zh` 运行时。

| 文件 | 用途 |
| --- | --- |
| `cdp_probe.mjs` | 连到某个 CEP 面板的调试端口，打印标题、文本节点数、DOM 摘要，并验证可修改页面 |
| `lib_smoke.mjs` | 不启动 Adobe：扫描本机扩展、检查 `.debug`、分配端口（dry-run 风格） |
| `probe_menu.jsx` | 在 AE 里用 `app.findMenuCommandId` 探测扩展菜单命令 ID |
| `quit_ae.jsx` | 通过 CEP 的 `evalScript` 让 AE 正常退出 |

用法示例：

```bat
node test\cdp_probe.mjs 8092
node test\lib_smoke.mjs
```

`probe_menu.jsx` / `quit_ae.jsx` 需要先连上一个已打开的面板调试端口，例如：

```bat
node tools\cep-zh\exec-jsx.mjs 8033 test\probe_menu.jsx
```

注意：`quit_ae.jsx` 在 AE 有未保存项目时会弹出保存对话框，这是 AE 的正常行为。
