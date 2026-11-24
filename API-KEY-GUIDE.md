# API KEY 测试与 AI 翻译配置教程

本文适用于 `ZyYu-CEP通用汉化管理`（0.7.x）。API Key **只保存在本机**：

```text
%APPDATA%\CEP-ZH\config.json
```

不会上传到 GitHub，也不会写入插件目录。请不要把 `config.json` 或包含 Key 的截图发给别人。

---

## 1. 支持的翻译方式

| 管理器中的 Provider | 是否需要 Key | Base URL | Model | 说明 |
| --- | --- | --- | --- | --- |
| `OpenAI 兼容 /chat/completions` | 是 | 服务商的 API 根地址 | 服务商提供的模型 ID | 适用于 OpenAI、DeepSeek、OpenRouter、OneAPI 等兼容接口 |
| `DeepL /v2/translate` | 是 | 免费版 `https://api-free.deepl.com`；Pro 版 `https://api.deepl.com` | 不需要 | 目标语言会自动转成 `ZH` |
| `Microsoft Edge 翻译` | 否 | 不需要 | 不需要 | 免登录，可能限流 |
| `Google 翻译` | 否 | 不需要 | 不需要 | 需要当前网络能访问 Google |
| `Yandex 翻译` | 否 | 不需要 | 不需要 | 免登录，可能限流 |
| `Mock（本地测试）` | 否 | 不需要 | 不需要 | 不联网，只返回 `【译】原文`，用于验证 UI 流程 |

> 本文重点讲需要 Key 的 OpenAI 兼容接口和 DeepL。

---

## 如何获取 API Key

下面按服务商分别说明。各平台页面和模型名称可能更新，以官网当前显示为准。

### DeepSeek（推荐给中文用户）

1. 打开 DeepSeek 开放平台：

   <https://platform.deepseek.com/>

2. 注册/登录后，确认账户有 API 余额（API 计费与网页版会员是分开的）。

3. 进入 API Keys 页面：

   <https://platform.deepseek.com/api_keys>

4. 点击创建 API Key，填一个容易辨认的名字，例如 `CEP-ZH`。

5. **Key 通常只完整显示一次**，立即复制保存；关闭弹窗后就看不到完整内容了。

6. 回到管理器填写：

   ```text
   PROVIDER: OpenAI 兼容 /chat/completions
   BASE URL: https://api.deepseek.com
   MODEL:    deepseek-chat
   API KEY:  刚复制的 Key
   TARGET:   zh-CN
   ```

   `MODEL` 也可以填 DeepSeek 文档里当前可用的其他模型 ID。

官方 API 文档：<https://api-docs.deepseek.com/>

### OpenAI

1. 打开 OpenAI 平台：

   <https://platform.openai.com/>

2. 登录后到 Billing / Credits 页面确认有 API 余额。**ChatGPT Plus 会员和 API 余额是两套计费**，Plus 会员不一定包含 API 额度。

3. 打开 API Keys 页面：

   <https://platform.openai.com/api-keys>

4. 点击 `Create new secret key`，命名后创建。

5. 完整 Key 只显示一次，立即复制保存。

6. 管理器填写：

   ```text
   PROVIDER: OpenAI 兼容 /chat/completions
   BASE URL: https://api.openai.com/v1
   MODEL:    gpt-4o-mini
   API KEY:  刚创建的 Key
   TARGET:   zh-CN
   ```

   模型可以换成你账号可用的其他模型。

OpenAI Key 帮助页：<https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key>

### DeepL

1. 打开 DeepL API 介绍页：

   <https://www.deepl.com/pro-api>

2. 选择 API Free 或 API Pro，按页面提示注册/开通。Free 有月度字符额度，Pro 按套餐计费，具体以页面为准。

3. 登录 DeepL 账号，在账户的 API Keys / Authentication Key 区域复制 Key。

   DeepL 官方认证说明：<https://developers.deepl.com/docs/getting-started/auth>

4. 管理器填写：

   ```text
   PROVIDER: DeepL /v2/translate
   BASE URL: https://api-free.deepl.com     （Free Key）
              https://api.deepl.com          （Pro Key）
   MODEL:    留空
   API KEY:  DeepL Authentication Key
   TARGET:   zh-CN
   ```

### OpenRouter / 其他 OpenAI 兼容服务

OpenRouter：

1. 打开 <https://openrouter.ai/> 并登录。
2. 在 Credits 页面充值/确认余额。
3. 打开 <https://openrouter.ai/keys> 创建 Key 并复制。
4. 管理器填写：

   ```text
   PROVIDER: OpenAI 兼容 /chat/completions
   BASE URL: https://openrouter.ai/api/v1
   MODEL:    在 OpenRouter 模型页复制的完整模型 ID，例如 provider/model
   API KEY:  OpenRouter Key
   TARGET:   zh-CN
   ```

如果是 OneAPI、NewAPI、公司内部网关等中转服务，请向服务商确认：

```text
Base URL（通常以 /v1 结尾）
模型 ID
API Key
```

然后按同样的方式填入管理器。

### 不需要 Key 的方式

如果只是测试界面或不想申请 Key，可以先选：

```text
Microsoft Edge 翻译（免登录）
Google 翻译（免登录）
Yandex 翻译（免登录）
Mock（本地测试，不联网）
```

免费接口可能限流，Google 还需要当前网络能访问 Google。

### 获取 Key 后的安全操作

- 不要截图完整 Key，不要发到群里或 Issue。
- 创建 Key 时设置容易辨认的名字，方便泄露后定位和删除。
- 在服务商后台设置消费上限/额度提醒。
- 如果 Key 曾出现在截图、录屏或日志里，立即在后台删除并重新创建。
- 测试阶段建议用便宜的模型，验证成功后再换正式模型。

---


## 2. 在管理器中填写 API 配置

1. 打开管理器：

   `窗口 > 扩展 > ZyYu-CEP通用汉化管理`

2. 点击左侧 `03 设置`。

3. 在 `01 / TRANSLATION API` 卡片中填写：

### OpenAI 兼容接口

| 字段 | 填法 |
| --- | --- |
| `PROVIDER` | `OpenAI 兼容 /chat/completions` |
| `BASE URL` | 例如 `https://api.deepseek.com`、`https://api.openai.com/v1`，或你的中转服务地址 |
| `MODEL` | 填服务商文档里的模型 ID，例如 `deepseek-chat`、`gpt-4o-mini` |
| `API KEY` | 你的 Key，通常以 `sk-` 开头 |
| `TARGET LANGUAGE` | `zh-CN` |

代码会自动在 Base URL 后拼接 `/chat/completions`；如果 Base URL 本身已经以 `/chat/completions` 结尾，则不会重复拼接。

### DeepL

| 字段 | 填法 |
| --- | --- |
| `PROVIDER` | `DeepL /v2/translate` |
| `BASE URL` | 免费 Key 填 `https://api-free.deepl.com`；Pro Key 填 `https://api.deepl.com` |
| `MODEL` | 留空 |
| `API KEY` | DeepL 的 Authentication Key |
| `TARGET LANGUAGE` | `zh-CN` |

4. 点击 `保存配置`。

   成功后会提示：

   ```text
   API 配置已保存（本机）
   ```

### 2.1 用“测试连接”按钮测试

确认管理器底部显示：

```text
AGENT / RUNNING ...
```

然后点击设置卡片里的 `测试连接` 按钮。

- 按钮会变成 `测试中…`
- 只会向 API 发送一条 `Test connection` 测试文本
- 不会写入插件字典

成功：

```text
API 连接成功：<翻译结果>
```

失败：

```text
API 连接失败：OpenAI HTTP 401 ...
```

如果提示 `Agent 未运行`，先打开 Adobe 应用，等管理器底部出现 `AGENT / RUNNING` 再试。

> 测试连接使用和真实 AI 翻译完全相同的 Provider / Base URL / Model / Key，因此能直接验证 Key 是否有效。

---

## 3. 可选：用命令行单独测试 Key（不会改字典）

如果管理器里的测试连接不方便，也可以用命令行。这种方式只翻译 1 条测试文本，不写入你的插件字典。

### 3.1 打开 PowerShell

进入已安装的 Agent 工具目录：

```powershell
cd "$env:LOCALAPPDATA\CEP-ZH\agent\tools\cep-zh"
```

### 3.2 OpenAI 兼容接口测试

如果你已经在管理器里保存了 Key，命令会自动读取 `config.json`，不需要把 Key 写在命令行里：

```powershell
node .\translate.mjs `
  --catalog .\catalog\cep.zh.test.json `
  --bundle cep.zh.test `
  --provider openai `
  --base-url "https://api.deepseek.com" `
  --model "deepseek-chat" `
  --target-lang zh-CN `
  --limit 1 `
  --out "$env:TEMP\cepzh-api-test.json"
```

如果还没有保存 Key，可以临时加：

```powershell
  --api-key "sk-你的Key"
```

但不建议在多人共用电脑或录屏时把 Key 直接写进命令。

### 3.3 DeepL 测试

```powershell
node .\translate.mjs `
  --catalog .\catalog\cep.zh.test.json `
  --bundle cep.zh.test `
  --provider deepl `
  --base-url "https://api-free.deepl.com" `
  --target-lang zh-CN `
  --limit 1 `
  --out "$env:TEMP\cepzh-api-test.json"
```

### 3.4 看结果

成功时类似：

```text
provider=openai bundle=cep.zh.test strings=1 config=C:\Users\你\AppData\Roaming\CEP-ZH\config.json
cache hit 0, request 1
wrote C:\Users\你\AppData\Local\Temp\cepzh-api-test.json (1 entries)
```

打开 `--out` 指定的 JSON，应该能看到一条中文翻译：

```json
{
  "name": "cep.zh.test",
  "strings": {
    "Localization Test Panel": "本地化测试面板"
  },
  "patterns": []
}
```

失败时会直接显示原因，例如：

```text
translate failed: OpenAI HTTP 401 Unauthorized ...
```

> 如果再次运行看到 `cache hit 1`，说明这条文本已被缓存，本次不会真正请求 API。要重新测试 Key，先删除：
>
> ```powershell
> Remove-Item .\cache\translate.json -ErrorAction SilentlyContinue
> ```
>
> 或换一个测试目录/测试文本。

### 3.5 支持的 CLI Provider

命令行测试目前支持：

```text
openai
deepl
mock
```

Edge / Google / Yandex 请用下面的界面方式测试。

---

## 4. 在界面里用 AI 翻译测试

### 4.1 先备份

建议先到 `04 导出 / 导入` 导出当前字典，避免测试翻译污染正式词条。

### 4.2 选一个未翻译条目很少的插件

1. 点击左侧 `01 插件字典`。
2. 在插件列表里找 `未翻译` 数量很少的插件，例如只有 1～3 条。
3. 不要一开始点 `AI 翻译全部字典`，那会对所有插件发起请求，可能产生较多费用。

### 4.3 可选的测试词条

如果插件里没有未翻译条目，可以手动加一条：

1. 点击 `＋ 添加词条`。
2. 原文填 `Test connection`。
3. 译文留空。
4. 确认添加。
5. 再点 `AI 翻译`。

注意：`AI 翻译` 会翻译当前插件的所有未翻译条目，不是只翻译你刚加的一条，所以仍建议选小插件。

### 4.4 发起测试

点击右上角的 `AI 翻译`（不要点侧栏底部的 `AI 翻译全部字典`）。

会先看到：

```text
已请求 AI 翻译当前插件
```

按钮变成：

```text
翻译中…
```

成功：

```text
AI 翻译完成：+N 条，跳过 M 条
```

失败：

```text
AI 翻译失败：OpenAI HTTP 401 ...
```

失败详情也会写入：

```text
%APPDATA%\CEP-ZH\state.json
```

查看 `translation.error` 字段即可。

### 4.5 测试后清理

- 如果只是加了测试词条，可以在表格里删除它。
- 如果测试把不想要的条目翻译了，用测试前的导出文件恢复。
- 不要用 `清空译文` 来清理测试，它会清掉当前插件的全部用户译文。

---

## 5. 常见错误

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| `OpenAI HTTP 401` | Key 错误、复制不完整、已被删除 | 重新复制 Key，确认没有前后空格 |
| `OpenAI HTTP 403` | Key 无权限、地区/网络限制、服务商风控 | 换网络或确认账号权限 |
| `OpenAI HTTP 404` | Base URL 写错、接口不是 `/chat/completions` | 确认 Base URL 只写到 `/v1` 或服务商根地址 |
| `OpenAI HTTP 429` | 额度不足、请求过快 | 检查余额/额度，稍后再试 |
| `model not found` / 模型不存在 | Model ID 拼错，或账号没有该模型 | 按服务商文档填写准确模型 ID |
| `translate failed: fetch failed` | 网络不通、代理未生效、DNS 问题 | 浏览器能打开服务商 API 域名后再试 |
| `翻译 API 未配置` | Provider 还是 `不启用`，或没有保存 | 选择 Provider 后点保存 |
| `AI 翻译完成：+0 条` | 所有条目已有译文，或文本被过滤 | 换一个未翻译插件，或添加测试词条 |
| 界面一直 `翻译中…` | Agent 未运行，或翻译请求超时 | 看管理器底部 Agent 状态；重启 Adobe 后再试 |
| 个别词条翻译后仍是英文 | 模型把短标签/技术标识原样返回；0.7.8 起仍相同不会写入 | 清空该条译文后重试，或手动改成中文；这不是 Key 失效 |
| Google 翻译失败 | 当前网络无法访问 Google | 换网络，或改用其他 Provider |

### 文本过滤规则

以下内容不会发送给 API：

- 纯中文、纯数字、纯符号
- URL、文件路径
- 含 `{}` 的模板字符串
- CSS 属性片段
- 长度超过 240 字符的文本
- 已经是中文的文本

所以“没有可翻译的条目”不一定代表 Key 有问题。

### 为什么 AI 跳过了某些词条

AI 翻译会跳过以下情况：

- 当前插件字典里已有非空译文
- 内置字典里已有非空译文
- 词条不符合可翻译规则（纯数字、URL、CSS、超过 240 字符等）

0.7.9 起，**公共字典里已有译文不再导致跳过**：如果当前插件字典里明确存在一个空词条，AI 仍会翻译它，用户可以之后决定保留插件译文还是删除它、改用公共字典。

例如 Flow 的 `com.rendertom.flow.json` 里：

```json
"Details…": "",
"default": ""
```

公共字典 [global.json](product/cep.zh.manager/dict/global.json) 里已经有：

```json
"Details…": "详情…",
"default": "默认"
```

0.7.9 起：

- 空插件条目会回退到公共字典，界面不会显示英文；
- 如果点击 AI 翻译，插件里的空条目也会被当作待翻译项，不再因为公共字典存在而跳过；
- 删除插件条目后，会自然走公共字典；
- 想单独改当前插件，直接编辑插件译文，插件译文优先。

### 变体识别

0.7.9 起运行时会识别常见前后缀变体，并保留标点/编号：

```text
Amount:    -> 数量：
Color 1    -> 颜色 1
EaseOut(   -> 缓出(
Details…   -> 详情…
default    -> 默认
```

匹配时会忽略大小写，并依次尝试去掉末尾标点、括号和数字后查基础词。公共字典里补了 `Amount`、`Color`、`Details`、`Ease`、`EaseIn`、`EaseOut` 等基础词。

### 为什么个别词条翻译后仍是英文

例如 `X LocalStore` 这类短标签，翻译 API 可能认为 `LocalStore` 是技术标识，按提示原样返回。

0.7.8 起增加了两层保护：

1. 提示词明确要求短标签、混合标签也要翻译，例如 `X LocalStore` 应译为 `X 本地存储`。
2. API 返回与原文相同时自动再请求一次；如果仍然相同，就不写入字典，并在完成提示里显示“同原文未写入”的数量。

因此新翻译一般不会再写入“译文等于原文”的假翻译。**已经存在的同原文条目不会被自动覆盖**，处理方式：

1. 在管理器搜索该原文。
2. 清空这条译文，等自动保存完成，再点一次 `AI 翻译`；或
3. 直接在译文输入框里改成中文，例如 `X 本地存储`。

这不是 Key 失效，也不代表该词条没被采集到。

---

## 6. 安全提醒

- Key 以明文保存在 `%APPDATA%\CEP-ZH\config.json`，这是本机配置文件，不是加密保险箱。
- 不要把 `config.json` 上传到 GitHub、网盘或聊天群。
- 截图前遮住 `API KEY` 输入框。
- 建议使用单独的低额度 Key，发现泄露立即在服务商后台删除/轮换。
- 本工具不会把 Key 写入插件目录，也不会通过管理器上传到 GitHub。

---

## 不用 API Key：逐行文本 + 网页 AI

插件字典现在支持两种视图：

```text
表格      每个词条一行输入框，分页显示
逐行文本  所有词条放进一个文本框，每行 原文=译文，不分页
```

适合手动把未翻译行复制到网页版 AI，不需要配置 API Key。

### 操作步骤

1. 打开管理器 → `01 插件字典`，选中插件。
2. 点工具栏的 `逐行文本`。
3. 可先用 `未翻译` 筛选，只保留需要翻译的行。
4. 在文本框中选中需要的行，复制。
5. 点 `复制网页端提示词`。
6. 打开网页版 AI，先粘贴提示词，再粘贴选中的行。
7. 把 AI 返回的 `原文=译文` 行粘贴回文本框。
8. 点 `应用修改`（输入框停止输入约 0.8 秒也会自动保存）。

### 预置提示词

按钮复制的提示词核心如下：

```text
你是一名专业的软件 UI 本地化翻译。下面我会粘贴若干行 CEP 面板文本，
每行格式严格为：原文=译文

请把每一行“=”左侧的英文 UI 原文翻译成简体中文，并填写到“=”右侧。

规则：
1. 只返回与输入相同行数的“原文=译文”，不要解释、不要 Markdown 代码块、不要编号。
2. 保留每行第一个“=”作为分隔符；原文或译文中已有的“=”继续保留。
3. 保留占位符、快捷键、URL、文件路径、数字、标点、括号、前缀和后缀。
4. 短标签和混合标签也要翻译，例如 Amount: -> 数量：, Color 1 -> 颜色 1, EaseOut( -> 缓出(。
5. 如果右侧已有中文，保留或改成更自然的中文，不要删除。
6. 如果某行确实无法翻译，输出原文=原文。
7. 不要合并或拆分行，不要添加输入之外的额外行。
```

### 解析规则

管理器按每行**第一个 `=`** 拆分原文和译文：

```text
Amount=数量
Color 1=颜色 1
EaseOut(=缓出(
```

- 只更新当前插件里已经存在的原文
- 文本中没有出现的词条不会被删除
- 空译文写成 `原文=`，会保存为空并继续走公共字典回退
- 如果原文本身包含 `=`，建议手动编辑，避免解析歧义
- 换行会以 `\n` 形式显示

> 网页 AI 可能会自行添加解释或代码块。预置提示词已要求只返回逐行结果，但不同模型表现不同，实际效果仍需测试。建议先备份字典，再批量应用。

## 7. 最短测试流程（总结）

```text
1. 设置 > 翻译 API
2. Provider 选 OpenAI 兼容
3. 填 Base URL、Model、API Key、目标语言 zh-CN
4. 保存配置
5. 确认底部 AGENT / RUNNING
6. 点击“测试连接”
7. 看到“API 连接成功”且返回中文 → Key 正常
8. 如果报 401/403/404/429 → 按第 5 节排查
```

如果只想验证界面流程、不消耗 API 额度，可以把 Provider 临时改成 `Mock（本地测试）`，这时测试连接和 AI 翻译都会返回 `【译】原文`，不需要 Key。

命令行方式仍保留在第 3 节，适合批量翻译或排查请求格式。
