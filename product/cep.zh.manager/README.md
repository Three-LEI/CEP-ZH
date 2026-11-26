# ZyYu-CEP通用汉化管理

管理 CEP 面板的汉化字典、开关、AI 配置和 `.debug` 修复。

## 使用

安装到：

```text
%APPDATA%\Adobe\CEP\extensions\cep.zh.manager
```

重启 Adobe 应用后打开：

```text
窗口 > 扩展 > ZyYu-CEP通用汉化管理
```

## 功能

- 左侧选择插件，表格直接编辑译文
- `表格` / `逐行文本` 两种视图；逐行文本按 `原文=译文` 展示，可复制到网页 AI
- 覆盖文本、`title`、`placeholder`、`aria-*`、按钮 `value`、选项 `label`、tooltip 等属性
- 支持同源 iframe、开放 Shadow DOM、同源弹窗和动态 DOM
- 保留编号、标点、快捷键、占位符和前后缀；支持常见词条变体
- 顶部全局汉化开关，右上角 `仅该插件汉化` 控制当前插件
- 默认自动捕获：点击、切换页面、滚动、获得焦点或路由变化后增量收集新词条；9 秒安全网覆盖无事件的页面切换
- `仅当前插件` 只捕获左侧选中的插件；`仅视口` 只捕获当前可见区域，滚动时补捕
- 插件列表显示扩展注册名（manifest 的 Menu，如 Motion 4），bundle id 作为悬停提示
- 侧栏 `自动翻译`：捕获到新词条后自动调用设置里的翻译接口；未配置接口时开关会拒绝并提示
- `清空译文` 保留词条只清空译文；`清空词条` 删除当前插件本机字典的全部词条与规则
- `整理词典` 清理接口原样返回、永远翻不出来的空词条，并合并空格/大小写重复词条
- `整理词典` 清理接口原样返回、永远翻不出来的空词条，并合并空格/大小写重复词条
- “捕获全部”重新扫描所有已打开面板
- “AI 翻译”处理当前插件或全部字典，全部翻译前会显示词条数量确认
- 免登录翻译源：Microsoft Edge、Google、Yandex；也可配置 OpenAI 兼容接口或 DeepL
- “导出 / 导入”备份和迁移字典
- 新增插件缺少 `.debug` 时显示顶部提示；用户目录自动修复，系统目录需要管理员权限
- 管理员写入由自带的 `CEP汉化修复工具.exe` 完成，不依赖 PowerShell
- 管理面板是独立 Modeless 窗口，关闭它不会影响 Agent 继续注入和热更新
- 内置 MiSans；旧 CEP 自动启用布局与 CDP 兼容

## 文件

```text
%APPDATA%\CEP-ZH\dict            用户字典
%APPDATA%\CEP-ZH\config.json     API 配置
%APPDATA%\CEP-ZH\control.json    开关和任务控制
%APPDATA%\CEP-ZH\state.json      Agent 状态（只读）
```

隐藏扩展 `cep.zh.agent` 随 Adobe 应用启动。
