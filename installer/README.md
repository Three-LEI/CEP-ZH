# 安装与调试脚本

- 正式安装：使用 [`native`](native/README.md) 下的 C++ 安装器。
- CEP9–11 单独补 `.debug`：运行 [`legacy-debug.ps1`](legacy-debug.ps1)。
- 旧的 PowerShell 实验安装器保留在 `install.ps1`，仅用于本地排查。

```powershell
powershell -ExecutionPolicy Bypass -File installer\legacy-debug.ps1 -Hosts AEFT -DryRun
powershell -ExecutionPolicy Bypass -File installer\legacy-debug.ps1 -Hosts AEFT
```
