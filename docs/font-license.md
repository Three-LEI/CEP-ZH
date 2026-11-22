# MiSans 字体许可说明

管理面板使用 **MiSans Regular / Medium** 两个官方 WOFF2 字重：

```text
product/cep.zh.manager/fonts/MiSans-Regular.woff2
product/cep.zh.manager/fonts/MiSans-Medium.woff2
```

字体来自小米官方：

- https://hyperos.mi.com/font/
- https://hyperos.mi.com/font-download/MiSans.zip

## 是否允许嵌入

小米官方 FAQ 明确说明：

- MiSans Global 可免费商用；
- **可以用作嵌入式字体**；
- 但必须在软件中特别注明使用了 MiSans 字体。

官方许可协议同时规定：

- 不得对字体或其单独组件进行改编或二次开发；
- 不得单独租赁、再许可、出借、再分发或售卖字体软件本身；
- 使用字体创作的作品可以正常分发/出售。

因此本项目：

1. 使用官方原始 WOFF2 文件，**未做子集化、格式转换或修改**；
2. 在管理面板“设置”页显示：  
   `字体：MiSans © Xiaomi · 依据 MiSans 字体许可嵌入`
3. 在 `fonts/LICENSE-MiSans.txt` 保留完整来源与许可说明。

如果后续要新增字重，请继续使用官方原文件并保留署名，不要自行改写字体。

## 公开仓库处理

公开 GitHub 仓库默认不提交 `*.woff2` 原始字体文件，只保留本说明和
`tools/fonts/extract_misans.py` 下载脚本；本地构建/安装包中再嵌入官方原文件。
这样避免把字体软件作为独立文件再分发。
