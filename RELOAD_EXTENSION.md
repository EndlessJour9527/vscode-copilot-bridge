# 如何重新加载扩展以应用更改

编译完成后，您需要在 VS Code 中重新加载扩展才能使新的代码生效。

## 方法 1: 重新加载 VS Code 窗口（推荐）

1. 在 VS Code 中按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Windows/Linux)
2. 输入 "Developer: Reload Window"
3. 回车执行

## 方法 2: 重启 Copilot Bridge

1. 在 VS Code 中按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Windows/Linux)
2. 输入 "Copilot Bridge: Disable"
3. 然后再执行 "Copilot Bridge: Enable"

## 验证修改是否生效

重新加载后，在终端测试：

```bash
curl -v -X POST "http://127.0.0.1:9527/v1/models/gemini-2.5-pro:generateContent?key=qweasd9527" \
  -H "Authorization: Bearer qweasd9527" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

如果成功，您将看到 200 OK 响应而不是 404 Not Found。
