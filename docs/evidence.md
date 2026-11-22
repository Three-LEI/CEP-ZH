# 实验证据（自动采集）

## 1. 版本
```
26.5
12.0.1
99.2.15+g71e9523+chromium-99.0.4844.84
```

## 2. CEPHtmlEngine 进程树与命令行（节选）
```
PID 7556 PPID 20040
"D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine\CEPHtmlEngine.exe" "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\flow\panel\index.html" 1a34d787-ade5-48f7-bcd9-d1f9e6b2b751 20040 AEFT 26.5 com.rendertom.flow 6 "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\flow" "AE_CApplication_26.5" 1 WyItLWVuYWJsZS1ub2RlanMiLCItLWFsbG93LWZpbGUtYWNjZXNzLWZyb20tZmlsZXMiLCItLWFsbG93LWZpbGUtYWNjZXNzIiwiLS1taXhlZC1jb250ZXh0Il0= zh_CN 4281479730 100 0

PID 2876 PPID 7556
"D:\Adobe\Adobe After Effects 2026\Support Files\CEPHtmlEngine\CEPHtmlEngine.exe" --type=gpu-process --no-sandbox --log-severity=error --user-agent-product="Chrome/99.0.4844.84 AdobeCEP/12.0.1" --lang=zh_CN --user-data-dir="C:\Users\LEI\AppData\Local\CEF\User Data" --params_ppid=AEFT --params_serverid=20040 --gpu-preferences=UAAAAAAAAADgAAAYAAAAAAAAAAAAAAAAAABgAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAAAAAAASAAAAAAAAAAYAAAAAgAAABAAAAAAAAAAGAAAAAAAAAAQAAAAAAAAAAAAAAAOAAAAEAAAAAAAAAABAAAADgAAAAgAAAAAAAAACAAAAAAAAAA= --log-file="C:\Users\LEI\AppData\Local\Temp\CEPHtmlEngine12-AEFT-26.5-com.rendertom.flow.log" --mojo-platform-channel-handle=1984 --field-trial-handle=2012,i,16121037287661760731,2122771907567285357,131072 --disable-features=CalculateNativeWinOcclusion,WinUseBrowserSpellChecker /prefetch:2

```

## 3. DevTools 端点
```
{"Browser":"Chrome/99.0.4844.84","Protocol-Version":"1.3","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 AdobeCEP/12.0.1 Safari/537.36","V8-Version":"9.9.115.10","WebKit-Version":"537.36 (@81a11fc2ee8a41e17451f29195387f276d3bb379)","webSocketDebuggerUrl":"ws://127.0.0.1:8092/devtools/browser/2237098a-d947-4d93-9302-c64d7dbb8b32"}
{"description":"","devtoolsFrontendUrl":"/devtools/inspector.html?ws=127.0.0.1:8092/devtools/page/D428E9CCE3E79911C7528C5236D01958","id":"D428E9CCE3E79911C7528C5236D01958","title":"Flow","type":"page","url":"file:///C:/Program%20Files%20(x86)/Common%20Files/Adobe/CEP/extensions/flow/panel/index.html","webSocketDebuggerUrl":"ws://127.0.0.1:8092/devtools/page/D428E9CCE3E79911C7528C5236D01958"}
```

## 4. CEP 日志（DevTools 监听）
```
DevTools listening on ws://127.0.0.1:8092/devtools/browser/2237098a-d947-4d93-9302-c64d7dbb8b32
2026-11-22 13:10:23:651 : INFO  TEST-LOADEXTENSION-PERFORMANCE, CEPHTMLENGINE, CreateBrowser begin.
2026-11-22 13:10:23:778 : INFO  TEST-LOADEXTENSION-PERFORMANCE, CEPHTMLENGINE, CreateBrowser end.
```

## 5. cep-zh 实时面板映射
```
bundles: 108   extension ids: 86   enabled .debug files: 0
live panels (4):
PORT	EXT	BUNDLE	TITLE
8033	com.overlord.panel	Overlord	Overlord
8053	com.overlord.panel	Overlord	Overlord
8092	com.rendertom.flow	com.rendertom.flow	Flow
39300			CEP ZH Test
```

## 6. .debug 示例（Overlord 自带）
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
    <Extension Id="com.overlord.panel">
        <HostList>
          <!-- Illustrator -->
          <Host Name="ILST" Port="8052" />
          <!-- AfterEffects -->
          <Host Name="AEFT" Port="8053" />
        </HostList>
    </Extension>
    <Extension Id="com.overlord.modal">
        <HostList>
          <!-- Illustrator -->
          <Host Name="ILST" Port="8042" />
          <!-- AfterEffects -->
          <Host Name="AEFT" Port="8043" />
        </HostList>
    </Extension>
    <Extension Id="com.overlord.hidden">
        <HostList>
          <!-- Illustrator -->
          <Host Name="ILST" Port="8032" />
          <!-- AfterEffects -->
          <Host Name="AEFT" Port="8033" />
        </HostList>
    </Extension>
</ExtensionList>

```
