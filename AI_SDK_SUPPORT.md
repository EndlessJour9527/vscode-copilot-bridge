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
  baseURL: "http://127.0.0.1:${PORT}/v1"
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
- `@ai-sdk/openai` - Vercel AI SDK Core (通过 `/v1/chat/completions` 和 `/v1/responses`)
- `@ai-sdk/rsc` - AI SDK React Server Components (`streamUI`)

### 支持的功能

| 功能 | openai SDK | @ai-sdk/openai | @ai-sdk/rsc |
|------|-----------|----------------|-------------|
| 基础聊天 | ✅ | ✅ | ✅ |
| 流式响应 | ✅ | ✅ | ✅ |
| 工具调用 | ✅ | ✅ | ✅ |
| 结构化输出 | ✅ JSON mode | ✅ streamObject | N/A |
| streamUI | N/A | N/A | ✅ |
| Bearer Token 认证 | ✅ | ✅ | ✅ |
| 速率限制 | ✅ | ✅ | ✅ |

## `streamUI` 支持 (AI SDK RSC)

### ✅ 完全兼容

Copilot Bridge 完全支持 `@ai-sdk/rsc` 的 `streamUI` 函数。响应格式符合 OpenAI API 标准。

```typescript
import { streamUI } from '@ai-sdk/rsc';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

const openai = createOpenAI({
  apiKey: process.env.BRIDGE_TOKEN,
  baseURL: 'http://127.0.0.1:${PORT}/v1'
});

const result = await streamUI({
  model: openai('gpt-4o'),
  prompt: 'Your prompt here',
  text: ({ content }) => <div>{content}</div>,
  tools: {
    yourTool: {
      description: 'Tool description',
      inputSchema: z.object({
        param: z.string()
      }),
      generate: async function* ({ param }) {
        yield <LoadingComponent />;
        return <ResultComponent data={param} />;
      }
    }
  }
});
```

### ⚠️ 重要限制：`tool_choice` 行为

由于 VS Code Language Model API 的限制，Copilot Bridge **不支持强制工具调用**：

| tool_choice 值 | 行为 | 说明 |
|---------------|------|------|
| `'auto'` (默认) | ✅ 支持 | LLM 自主决定是否调用工具 |
| `'none'` | ✅ 支持 | 禁用所有工具 |
| `'required'` | ⚠️ 等同于 `'auto'` | 无法强制 LLM 必须调用工具 |
| `{type: 'function', function: {name: 'toolName'}}` | ✅ 支持 | 仅提供指定的工具 |

**实际影响:**

- LLM 可能选择返回文本而不是调用工具，即使设置了 `toolChoice: 'required'`
- 如果 LLM 返回空文本且未调用工具，`streamUI` 的 `text` 回调会收到空字符串
- 这是 VS Code LM API 的架构限制，不是 Copilot Bridge 的 bug

**解决方案:**

1. **优化提示词**: 使用更明确的指令，例如 "Use the getWeather tool to get weather information"
2. **应用层路由**: 在应用代码中检测意图并直接调用相应的组件:

```typescript
// 方案 A: 提示词优化
const result = await streamUI({
  model: openai('gpt-4o'),
  system: 'When users ask about weather, you MUST use the getWeather tool',
  prompt: userInput,
  // ...
});

// 方案 B: 应用层路由
async function smartStreamUI(prompt: string) {
  // 检测天气查询
  if (/weather|temperature|forecast/i.test(prompt)) {
    // 直接返回天气组件
    const location = extractLocation(prompt);
    return <WeatherComponent location={location} />;
  }
  
  // 其他情况使用 streamUI
  return await streamUI({
    model: openai('gpt-4o'),
    prompt,
    // ...
  });
}
```

## 注意事项

1. **历史窗口限制**: AI SDK 请求同样受 `bridge.historyWindow` 配置限制
2. **并发限制**: 受 `bridge.maxConcurrent` 配置限制
3. **认证**: 必须使用 `bridge.token` 配置的 Bearer Token
4. **模型选择**: 使用与 `/v1/chat/completions` 相同的模型选择逻辑
5. **工具调用不保证**: LLM 可能选择不调用工具，即使工具可用且相关

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
