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

- 左侧选择插件，表格直接编辑译文
- 顶部开关控制全局汉化 / 单插件汉化
- “捕获已打开插件”重新扫描面板
- “AI 翻译”处理当前插件或全部字典
- “导出 / 导入”备份和迁移字典
- 新增插件缺少 `.debug` 时会显示顶部提示；用户目录自动修复，系统目录需要管理员权限
- 面板缩小时自动进入 compact / micro 模式，只保留全局开关

## 文件

```text
%APPDATA%\CEP-ZH\dict            用户字典
%APPDATA%\CEP-ZH\config.json     API 配置
%APPDATA%\CEP-ZH\control.json    开关和任务控制
%APPDATA%\CEP-ZH\state.json      Agent 状态（只读）
```

隐藏扩展 `cep.zh.agent` 随 Adobe 应用启动，管理面板关闭后仍会继续注入和热更新。
