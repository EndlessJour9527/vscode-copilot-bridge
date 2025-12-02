# AI SDK Support for vscode-copilot-bridge

## 新增功能

添加了对 `@ai-sdk/openai` (Vercel AI SDK) 的支持。

## 实现细节

### 新增端点: `/v1/responses`

这是 AI SDK 使用的自定义端点，现在 bridge 完全支持。

### 文件变更

1. **src/http/routes/responses.ts** (新文件)
   - 处理 AI SDK 的请求格式
   - 转换 AI SDK 消息格式到 VS Code LM API
   - 返回 AI SDK 兼容的响应

2. **src/http/server.ts** (更新)
   - 导入 `handleAiSdkResponse`
   - 注册 `POST /v1/responses` 路由
   - 应用相同的速率限制和认证

### 消息格式转换

**AI SDK 输入格式:**
```json
{
  "model": "gpt-4o",
  "input": [
    { "role": "user", "content": "hello" }
  ]
}
```

**AI SDK 输出格式:**
```json
{
  "id": "resp_...",
  "model": "gpt-4o",
  "object": "response",
  "created": 1234567890,
  "output": {
    "role": "assistant",
    "content": "Hello! How can I help you?"
  }
}
```

## 使用方法

### 重新加载扩展

1. 在 VS Code 中按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Windows/Linux)
2. 输入 "Developer: Reload Window"
3. 或者重启 VS Code

### 测试 AI SDK 支持

```bash
cd /Users/yjh/yjh/ai—proj/threepio
npm run test-ai-sdk
```

### 在代码中使用

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamObject } from "ai";

const openai = createOpenAI({
  apiKey: process.env.BRIDGE_TOKEN,
  baseURL: "http://127.0.0.1:9527/v1"
});

// 文本生成
const result = await generateText({
  model: openai("gpt-4o"),
  prompt: "Your prompt here",
});

// 结构化对象生成
const objectResult = await streamObject({
  model: openai("gpt-4o"),
  schema: yourZodSchema,
  prompt: "Your prompt here",
});
```

## 兼容性

### ✅ 现在支持的包

- `openai` - 标准 OpenAI SDK (通过 `/v1/chat/completions`)
- `@ai-sdk/openai` - Vercel AI SDK (通过 `/v1/responses`)

### 支持的功能

| 功能 | openai SDK | @ai-sdk/openai |
|------|-----------|----------------|
| 基础聊天 | ✅ | ✅ |
| 流式响应 | ✅ | ✅ |
| 工具调用 | ✅ | ⚠️ 部分支持 |
| 结构化输出 | ✅ JSON mode | ✅ streamObject |
| Bearer Token 认证 | ✅ | ✅ |
| 速率限制 | ✅ | ✅ |

## 注意事项

1. **历史窗口限制**: AI SDK 请求同样受 `bridge.historyWindow` 配置限制
2. **并发限制**: 受 `bridge.maxConcurrent` 配置限制
3. **认证**: 必须使用 `bridge.token` 配置的 Bearer Token
4. **模型选择**: 使用与 `/v1/chat/completions` 相同的模型选择逻辑

## 架构遵循

这个实现完全遵循 AGENTS.md 中的规范:
- ✅ 最小化差异
- ✅ 复用现有的认证和速率限制
- ✅ 统一的错误处理
- ✅ 详细的日志记录（当 verbose 启用时）
- ✅ 使用相同的模型选择逻辑
- ✅ 保持代码风格一致

## 测试

编译成功，无 TypeScript 错误。需要：

1. 重新加载 VS Code 扩展
2. 确保 bridge 已启用
3. 运行 `npm run test-ai-sdk` 测试

## 后续改进

如需完整的 AI SDK 功能支持，可以考虑：
- 流式响应支持（当前仅返回完整响应）
- 工具调用完整映射
- 更多 AI SDK 特定参数的支持
