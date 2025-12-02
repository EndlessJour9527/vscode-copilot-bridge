import * as vscode from 'vscode';
import type { IncomingMessage, ServerResponse } from 'http';
import { state } from '../../state';
import { readJson, writeErrorResponse, writeJson } from '../utils';
import { verbose } from '../../log';
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
    
    // Log the actual request body for debugging
    verbose(`AI SDK request body: ${JSON.stringify(body, null, 2)}`);
    
    if (!isAiSdkRequest(body)) {
      verbose(`AI SDK request validation failed. Body: ${JSON.stringify(body)}`);
      writeErrorResponse(res, 400, 'invalid request format', 'invalid_request_error', 'invalid_payload');
      return;
    }

    // Resolve model
    const model = await getModel(false, body.model);
    if (!model) {
      const hasLanguageModels = hasLMApi();
      if (body.model && hasLanguageModels) {
        writeErrorResponse(res, 404, 'model not found', 'invalid_request_error', 'model_not_found', 'not_found');
      } else {
        const reason = hasLanguageModels ? 'copilot_model_unavailable' : 'missing_language_model_api';
        writeErrorResponse(res, 503, 'Copilot unavailable', 'server_error', 'copilot_unavailable', reason);
      }
      return;
    }

    // Convert messages
    const config = getBridgeConfig();
    const lmMessages = convertAiSdkMessagesToLM(body.input);
    
    // Apply history window
    const recentMessages = lmMessages.slice(-config.historyWindow * 2);
    
    verbose(`AI SDK LM request model=${model.family || model.id || 'unknown'}`);

    // Send request to LM
    const cancellationToken = new vscode.CancellationTokenSource();
    
    try {
      const response = await model.sendRequest(
        recentMessages,
        {},
        cancellationToken.token
      );

      // Collect full response
      let fullContent = '';
      try {
        for await (const chunk of response.text) {
          fullContent += chunk;
        }
      } finally {
        if ('dispose' in response && typeof response.dispose === 'function') {
          response.dispose();
        }
      }

      // Build AI SDK compatible response
      // Estimate token counts (rough approximation: 1 token ~= 4 characters)
      const inputText = recentMessages.map(m => 
        typeof m.content === 'string' ? m.content : 
        Array.isArray(m.content) ? m.content.map(p => typeof p === 'string' ? p : '').join('') : ''
      ).join('');
      const inputTokens = Math.ceil(inputText.length / 4);
      const outputTokens = Math.ceil(fullContent.length / 4);
      
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      
      const aiSdkResponse: AiSdkResponse = {
        id: `resp_${nowMs}_${Math.random().toString(36).substring(7)}`,
        model: body.model,
        object: 'response',
        created: nowSec,
        created_at: nowSec,
        output: [
          {
            id: `msg_${nowMs}_${Math.random().toString(36).substring(7)}`,
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: fullContent,
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };

      writeJson(res, 200, aiSdkResponse);
      verbose(`AI SDK request complete`);
    } finally {
      cancellationToken.dispose();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    verbose(`AI SDK request error: ${errorMessage}`);
    writeErrorResponse(res, 500, errorMessage || 'internal_error', 'server_error', 'internal_error');
  } finally {
    state.activeRequests--;
    verbose(`AI SDK request cleanup (active=${state.activeRequests})`);
  }
}
