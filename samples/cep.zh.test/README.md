# cep.zh.test — 注入汉化验证面板

这是一个用于验证 `cep-zh` 的 CEP 面板，故意包含：

- 普通文本、按钮、`title` / `placeholder` / `aria-label` 属性；
- 每 900ms 更新的动态状态与帧数（验证 MutationObserver + patterns）；
- 同源 iframe（验证 iframe 注入）；
- Shadow DOM（验证 shadowRoot 遍历）；
- `<pre><code>` 与 `contenteditable`（验证跳过规则）。

## 安装

把整个 `cep.zh.test` 目录复制到：

```text
%APPDATA%\Adobe\CEP\extensions\cep.zh.test
```

然后在仓库根目录执行：

```bat
node tools\cep-zh\cli.mjs enable --only cep.zh.test --hosts AEFT
```

完全退出并重启 After Effects，在 `窗口 > 扩展 > CEP-ZH Test` 打开面板。

## 汉化

`tools/cep-zh/dict/extensions/cep.zh.test.json` 已经包含该面板的词条。
启动 Agent：

```bat
node tools\cep-zh\cli.mjs agent --verbose
```

面板应立即变中文；修改字典可观察热更新。

## 卸载

```bat
node tools\cep-zh\cli.mjs disable
```

然后删除 `%APPDATA%\Adobe\CEP\extensions\cep.zh.test`。
