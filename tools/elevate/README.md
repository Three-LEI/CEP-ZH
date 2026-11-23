# CEP汉化修复工具

`CEP汉化修复工具.exe` 是 CEP-ZH 的管理员写入助手。它是 `asInvoker` 程序，需要管理员权限时通过 `ShellExecuteEx("runas")` 自行提权，不依赖 PowerShell。

## 构建

```powershell
powershell -ExecutionPolicy Bypass -File tools\elevate\scripts\build.ps1
```

产物：

```text
tools\elevate\dist\CEP汉化修复工具.exe
```

固定使用静态 CRT，无第三方运行时依赖。

## job / result 协议

job 文件为 UTF-8 文本：

```text
CEPZH-ELEVATE 1
<目标 .debug 路径>	<暂存 .debug 路径>	<备份路径>
```

- 目标路径必须是 Adobe CEP 扩展目录或 Adobe 应用的 `Support Files` 下的 `.debug`；
- 暂存文件必须位于 `%TEMP%\CEP-ZH` 下；
- 备份路径为空时使用 `<目标>.cep-zh.bak`。

result 文件：

```text
V1
<目标路径>	<0/1>	<是否新建>	<备份路径>	<错误信息>
```

返回码：

- `0`：全部成功
- `2`：部分失败
- `1`：参数/协议错误
- `1223`：用户取消 UAC

Agent 通过 CLI 生成 job，再启动本工具；工具等待管理员实例完成后返回，不需要 `powershell.exe`。
