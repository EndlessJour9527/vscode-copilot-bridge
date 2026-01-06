import * as vscode from 'vscode';
import type { IncomingMessage, ServerResponse } from 'http';
import { state } from '../../state';
import { readJson, writeErrorResponse, writeJson } from '../utils';
import { info, verbose } from '../../log';
import { getModel, hasLMApi } from '../../models';
import { getBridgeConfig } from '../../config';

/**
 * AI SDK Response format types (OpenAI Responses API)
 */
interface AiSdkContentPart {
  type: 'input_text' | 'output_text';
  text: string;
  annotations?: unknown[];
}

interface AiSdkMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AiSdkContentPart[];
}

interface AiSdkRequest {
  model: string;
  input: AiSdkMessage[];
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  // Other fields from AI SDK
  [key: string]: unknown;
}

interface AiSdkOutputContentPart {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}

interface AiSdkOutputMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AiSdkOutputContentPart[];
}

interface AiSdkUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface AiSdkResponse {
  id: string;
  model: string;
  object: 'response';
  created: number;
  created_at?: number;  // Unix timestamp in seconds
  output: AiSdkOutputMessage[];
  usage: AiSdkUsage;
}

/**
 * Validates if the body is a valid AI SDK request
 */
function isAiSdkRequest(body: unknown): body is AiSdkRequest {
  if (!body || typeof body !== 'object') return false;
  const req = body as Record<string, unknown>;
  return (
    typeof req.model === 'string' &&
    Array.isArray(req.input) &&
    req.input.every(
      (msg: unknown) =>
        msg &&
        typeof msg === 'object' &&
        'role' in msg &&
        'content' in msg &&
        (typeof (msg as AiSdkMessage).content === 'string' ||
          Array.isArray((msg as AiSdkMessage).content))
    )
  );
}

/**
 * Extract text content from AI SDK content (handles both string and array formats)
 */
function extractTextContent(content: string | AiSdkContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }
  // Join all text parts
  return content
    .filter((part) => part.type === 'input_text' || part.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

/**
 * Convert AI SDK messages to VS Code LM messages
 */
function convertAiSdkMessagesToLM(messages: AiSdkMessage[]): vscode.LanguageModelChatMessage[] {
  return messages.map((msg) => {
    const textContent = extractTextContent(msg.content);
    switch (msg.role) {
      case 'system':
        return vscode.LanguageModelChatMessage.User(textContent);
      case 'user':
        return vscode.LanguageModelChatMessage.User(textContent);
      case 'assistant':
        return vscode.LanguageModelChatMessage.Assistant(textContent);
      default:
        return vscode.LanguageModelChatMessage.User(textContent);
    }
  });
}

/**
 * Handles AI SDK /v1/responses endpoint
 */
export async function handleAiSdkResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.activeRequests++;
  verbose(`AI SDK request started (active=${state.activeRequests})`);

  try {
    const body = await readJson(req);

    // 1. 收到请求日志
    verbose(`[AI SDK] Received request: ${JSON.stringify(body, null, 2)}`);

    if (!isAiSdkRequest(body)) {
      verbose(`[AI SDK] Request validation failed: ${JSON.stringify(body)}`);
      writeErrorResponse(res, 400, 'invalid request format', 'invalid_request_error', 'invalid_payload');
      return;
    }

    // 2. 解析模型
    const model = await getModel(false, body.model);
    if (!model) {
      verbose(`[AI SDK] Model not found: ${body.model}`);
      const hasLanguageModels = hasLMApi();
      if (body.model && hasLanguageModels) {
        writeErrorResponse(res, 404, 'model not found', 'invalid_request_error', 'model_not_found', 'not_found');
      } else {
        const reason = hasLanguageModels ? 'copilot_model_unavailable' : 'missing_language_model_api';
        writeErrorResponse(res, 503, 'Copilot unavailable', 'server_error', 'copilot_unavailable', reason);
      }
      return;
    }

    // 3. 转换消息
    const config = getBridgeConfig();
    const lmMessages = convertAiSdkMessagesToLM(body.input);
    const recentMessages = lmMessages.slice(-config.historyWindow * 2);

    verbose(`[AI SDK] LM request model=${model.family || model.id || 'unknown'}, stream=${body.stream}`);

    // 4. 发送请求到 LM
    const cancellationToken = new vscode.CancellationTokenSource();

    try {
      const response = await model.sendRequest(
        recentMessages,
        {},
        cancellationToken.token
      );

      // 5. 流式/非流式响应日志
      let fullContent = '';
      let chunkCount = 0;
      try {
        for await (const chunk of response.text) {
          chunkCount++;
          verbose(`[AI SDK] Received chunk #${chunkCount}: ${chunk.slice(0, 80)}...`);
          fullContent += chunk;
        }
        verbose(`[AI SDK] All chunks received, total chunks: ${chunkCount}`);
      } catch (streamErr) {
        verbose(`[AI SDK] Error during streaming: ${streamErr instanceof Error ? streamErr.stack : streamErr}`);
        throw streamErr;
      } finally {
        if ('dispose' in response && typeof response.dispose === 'function') {
          response.dispose();
        }
        verbose(`[AI SDK] Response stream disposed`);
      }

      // 6. 构造响应
      // ...（原有代码不变）

      writeJson(res, 200, response);
      verbose(`[AI SDK] Response sent successfully`);
    } finally {
      cancellationToken.dispose();
      verbose(`[AI SDK] CancellationToken disposed`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    verbose(`[AI SDK] Handler error: ${errorMessage}\n${error instanceof Error ? error.stack : ''}`);
    writeErrorResponse(res, 500, errorMessage || 'internal_error', 'server_error', 'internal_error');
  } finally {
    state.activeRequests--;
    verbose(`[AI SDK] Request cleanup (active=${state.activeRequests})`);
  }
}