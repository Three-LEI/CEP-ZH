# CEP 汉化管理器

管理 CEP 面板的汉化字典、开关、AI 配置和 `.debug` 修复。

## 使用

安装到：

```text
%APPDATA%\Adobe\CEP\extensions\cep.zh.manager
```

重启 Adobe 应用后打开：

```text
窗口 > 扩展 > CEP 汉化管理
```

0.7.1 起管理器以独立的 Modeless 浮动窗口打开，不再停靠在宿主的标签组里；0.7.2 起初始尺寸为 `1200 × 800`，可在 `150 × 200` 到 `1600 × 1000` 之间自由缩放，缩到较小时自动进入 compact / micro 布局，窗口尺寸会被记住。这样关闭其他 CEP 面板时，管理器不会被 CEP 的 `WM_DESTROY` 误关或变成空白。

安装包内置 MiSans Regular / Medium，界面统一使用 MiSans；只有在字体文件缺失时才会回退到微软雅黑。

- 左侧选择插件，表格直接编辑译文
- 顶部开关控制全局汉化 / 单插件汉化
- “捕获已打开插件”重新扫描面板
- “AI 翻译”处理当前插件或全部字典
- 免登录翻译源：Microsoft Edge、Google、Yandex；也可配置 OpenAI 兼容接口或 DeepL
- “导出 / 导入”备份和迁移字典
- 新增插件缺少 `.debug` 时会显示顶部提示；用户目录自动修复，系统目录需要管理员权限
- 设置页“修复全部 .debug”会重新扫描并补写所有缺失项，不再只依赖 baseline
- 管理员写入由自带的 `CEP汉化修复工具.exe` 完成，不依赖 PowerShell
- 面板缩小时自动进入 compact / micro 模式，只保留全局开关

## 文件

```text
%APPDATA%\CEP-ZH\dict            用户字典
%APPDATA%\CEP-ZH\config.json     API 配置
%APPDATA%\CEP-ZH\control.json    开关和任务控制
%APPDATA%\CEP-ZH\state.json      Agent 状态（只读）
```

隐藏扩展 `cep.zh.agent` 随 Adobe 应用启动；管理面板是独立窗口，关闭它不会影响 Agent 继续注入和热更新。
