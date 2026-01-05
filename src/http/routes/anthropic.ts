import * as vscode from 'vscode';
import type { IncomingMessage, ServerResponse } from 'http';
import { readJson, writeErrorResponse } from '../utils';
import { verbose } from '../../log';
import { getModel, hasLMApi } from '../../models';
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicTool,
  AnthropicStreamEvent,
  AnthropicStopReason,
} from '../../types/anthropic-types';

/**
 * Type guard to check if request is valid Anthropic Messages request
 */
function isAnthropicMessagesRequest(body: unknown): body is AnthropicMessagesRequest {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const req = body as Partial<AnthropicMessagesRequest>;
  return (
    typeof req.model === 'string' &&
    Array.isArray(req.messages) &&
    typeof req.max_tokens === 'number'
  );
}

/**
 * Handles Anthropic Messages API requests, converting to VS Code LM and back to Anthropic format.
 * Supports both streaming and non-streaming responses with tool calling.
 * Note: activeRequests counter is managed by the caller (server.ts route handler)
 * @param req - HTTP request object
 * @param res - HTTP response object
 */
export async function anthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = `anthropic-${Math.random().toString(36).slice(2)}`;
  verbose(`[${requestId}] Anthropic request received`);
  
  try {
    const body = await readJson(req);
    verbose(`[${requestId}] Request body parsed: model=${(body as any).model}, stream=${(body as any).stream}, messages_count=${Array.isArray((body as any).messages) ? (body as any).messages.length : 0}`);
    
    if (!isAnthropicMessagesRequest(body)) {
      verbose(`[${requestId}] Invalid request format`);
      writeErrorResponse(res, 400, 'invalid request', 'invalid_request_error', 'invalid_payload');
      return;
    }

    const model = await resolveModel(body.model, res);
    if (!model) {
      verbose(`[${requestId}] Model resolution failed for: ${body.model}`);
      return;
    }

    verbose(`[${requestId}] Model resolved: ${model.family || model.id || model.name || 'unknown'}`);

    // Convert Anthropic request to VS Code LM format
    verbose(`[${requestId}] Converting Anthropic request to VS Code LM format...`);
    verbose(`[${requestId}] Input messages: ${body.messages.length}`);
    body.messages.forEach((m, i) => {
      const contentDesc = Array.isArray(m.content) 
        ? m.content.map(c => c.type).join(',')
        : 'string';
      verbose(`[${requestId}]   [${i}] role=${m.role}, content_types=[${contentDesc}]`);
    });
    
    const lmMessages = convertAnthropicMessagesToLM(body.messages, body.system);
    verbose(`[${requestId}] Converted messages: count=${lmMessages.length}`);
    
    const lmTools = body.tools ? convertAnthropicToolsToLM(body.tools) : [];
    verbose(`[${requestId}] Converted tools: count=${lmTools.length}`);
    if (lmTools.length > 0) {
      lmTools.forEach(t => verbose(`[${requestId}]   - Tool: ${t.name}`));
    }
    
    const requestOptions: vscode.LanguageModelChatRequestOptions = lmTools.length > 0 
      ? { tools: lmTools } 
      : {};

    verbose(`[${requestId}] Sending request to VS Code LM API...`);

    const cancellationToken = new vscode.CancellationTokenSource();

    try {
      const response = await model.sendRequest(
        lmMessages,
        requestOptions,
        cancellationToken.token
      );

      verbose(`[${requestId}] VS Code LM response received, processing...`);

      try {
        if (body.stream === true) {
          verbose(`[${requestId}] Streaming response mode enabled`);
          await streamAnthropicResponse(res, response, body.model, body.max_tokens, requestId);
          verbose(`[${requestId}] Stream response fully sent`);
        } else {
          verbose(`[${requestId}] Non-streaming response mode`);
          await sendAnthropicCompletionResponse(res, response, body.model, requestId);
          verbose(`[${requestId}] Non-stream response sent`);
        }
      } finally {
        disposeResponse(response);
      }
    } finally {
      cancellationToken.dispose();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    verbose(`[${requestId}] Error: ${errorMessage}`);
    throw error;
  }
}

// ============================================================================
// Request Conversion Functions (Anthropic → VS Code LM)
// ============================================================================

/**
 * Convert Anthropic messages to VS Code Language Model messages
 * Handles system messages, text content, and tool results
 */
function convertAnthropicMessagesToLM(
  messages: AnthropicMessage[],
  system?: string | Array<{ type: 'text'; text: string }>
): vscode.LanguageModelChatMessage[] {
  const lmMessages: vscode.LanguageModelChatMessage[] = [];

  // Add system message if provided
  if (system) {
    const systemText = typeof system === 'string' 
      ? system 
      : system.map(block => block.text).join('\n');
    lmMessages.push(vscode.LanguageModelChatMessage.User(systemText));
  }

  // Convert each message
  for (const msg of messages) {
    const isContentArray = Array.isArray(msg.content);
    let content = '';
    let hasToolResult = false;
    let hasToolUse = false;

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else {
      // Check for special content types
      hasToolResult = msg.content.some(block => block.type === 'tool_result');
      hasToolUse = msg.content.some(block => block.type === 'tool_use');
      
      if (hasToolResult) {
        // Log tool_result details for debugging loop
        const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result') as any[];
        toolResultBlocks.forEach(block => {
          const contentStr = typeof block.content === 'string' 
            ? block.content 
            : (Array.isArray(block.content) ? JSON.stringify(block.content) : '');
          verbose(`[convert-msg] Tool result detected: tool_use_id=${block.tool_use_id}, content_len=${contentStr.length}`);
        });
      }
      
      if (hasToolUse) {
        // Log tool_use blocks in message history
        const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use') as any[];
        toolUseBlocks.forEach(block => {
          verbose(`[convert-msg] Tool use in history: name=${block.name}, tool_use_id=${block.id}`);
        });
      }
      
      content = extractTextFromContentBlocks(msg.content);
    }
    
    if (msg.role === 'user') {
      verbose(`[convert-msg] User message: content_len=${content.length}, has_tool_result=${hasToolResult}`);
      lmMessages.push(vscode.LanguageModelChatMessage.User(content));
    } else if (msg.role === 'assistant') {
      verbose(`[convert-msg] Assistant message: content_len=${content.length}, has_tool_use=${hasToolUse}`);
      lmMessages.push(vscode.LanguageModelChatMessage.Assistant(content));
    }
  }

  return lmMessages;
}

/**
 * Extract text content from Anthropic content blocks
 */
function extractTextFromContentBlocks(blocks: AnthropicContentBlock[]): string {
  const textParts: string[] = [];
  
  for (const block of blocks) {
    if (block.type === 'text') {
      const textBlock = block as AnthropicTextBlock;
      textParts.push(textBlock.text);
    } else if (block.type === 'tool_result') {
      // Extract tool_result content - it can be string or array
      const toolResultBlock = block as any;
      if (typeof toolResultBlock.content === 'string') {
        textParts.push(toolResultBlock.content);
      } else if (Array.isArray(toolResultBlock.content)) {
        // If content is an array, extract text from it
        const contentText = toolResultBlock.content
          .map((c: any) => typeof c === 'string' ? c : (c.type === 'text' ? c.text : ''))
          .join('\n');
        if (contentText) {
          textParts.push(contentText);
        }
      }
    }
  }
  
  return textParts.join('\n');
}

/**
 * Convert Anthropic tools to VS Code LM tools
 */
function convertAnthropicToolsToLM(tools: AnthropicTool[]): vscode.LanguageModelChatTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.input_schema as object,
  }));
}

// ============================================================================
// Response Conversion Functions (VS Code LM → Anthropic)
// ============================================================================

/**
 * Streams Anthropic-formatted response using Server-Sent Events
 */
async function streamAnthropicResponse(
  res: ServerResponse,
  response: vscode.LanguageModelChatResponse,
  modelName: string,
  maxTokens: number,
  requestId: string
): Promise<void> {
  // Disable Nagle's algorithm for lower latency
  if (res.socket) {
    res.socket.setNoDelay(true);
  }
  
  const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  
  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const messageId = `msg_${Math.random().toString(36).slice(2)}`;
  verbose(`[${requestId}] Streaming SSE response started, messageId=${messageId}`);

  // Send message_start event
  const messageStartEvent: AnthropicStreamEvent = {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelName,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
  writeSseEvent(res, messageStartEvent);
  verbose(`[${requestId}] Sent message_start event`);

  let contentBlockIndex = 0;
  let currentTextBlock = false;
  let sawToolCall = false;
  let textBuffer = '';
  const BUFFER_FLUSH_SIZE = 100; // Flush buffer every 100 chars to balance latency and throughput

  async function flushTextBuffer() {
    if (textBuffer.length > 0) {
      const delta: AnthropicStreamEvent = {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: {
          type: 'text_delta',
          text: textBuffer,
        },
      };
      writeSseEvent(res, delta);
      verbose(`[${requestId}] Sent text_delta: ${textBuffer.length} chars (buffered)`);
      textBuffer = '';
    }
  }

  for await (const part of response.stream) {
    if (isToolCallPart(part)) {
      // Flush any pending text before processing tool call
      await flushTextBuffer();

      sawToolCall = true;
      verbose(`[${requestId}] Tool call detected: name=${part.name}, callId=${part.callId}`);
      
      // Close any open text block
      if (currentTextBlock) {
        const blockStop: AnthropicStreamEvent = {
          type: 'content_block_stop',
          index: contentBlockIndex,
        };
        writeSseEvent(res, blockStop);
        contentBlockIndex++;
        currentTextBlock = false;
      }
      
      // Start tool_use block
      const blockStart: AnthropicStreamEvent = {
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: {
          type: 'tool_use',
          id: part.callId,
          name: part.name,
          input: {},
        },
      };
      writeSseEvent(res, blockStart);

      // Send input_json_delta
      const delta: AnthropicStreamEvent = {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(part.input),
        },
      };
      writeSseEvent(res, delta);

      // End tool_use block
      const blockStop: AnthropicStreamEvent = {
        type: 'content_block_stop',
        index: contentBlockIndex,
      };
      writeSseEvent(res, blockStop);
      contentBlockIndex++;

    } else {
      const text = extractTextContent(part);
      if (text) {
        // Start text block if needed
        if (!currentTextBlock) {
          const blockStart: AnthropicStreamEvent = {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: {
              type: 'text',
              text: '',
            },
          };
          writeSseEvent(res, blockStart);
          verbose(`[${requestId}] Sent content_block_start for text`);
          currentTextBlock = true;
        }

        // Buffer text and flush periodically to balance responsiveness
        textBuffer += text;
        if (textBuffer.length >= BUFFER_FLUSH_SIZE) {
          await flushTextBuffer();
        }
      }
    }
  }

  // Flush any remaining text
  await flushTextBuffer();

  // Close any open text block
  if (currentTextBlock) {
    const blockStop: AnthropicStreamEvent = {
      type: 'content_block_stop',
      index: contentBlockIndex,
    };
    writeSseEvent(res, blockStop);
    verbose(`[${requestId}] Sent content_block_stop for text`);
  }

  // Send message_delta with stop_reason
  const stopReason: AnthropicStopReason = sawToolCall ? 'tool_use' : 'end_turn';
  verbose(`[${requestId}] Sending message_delta with stop_reason=${stopReason}`);
  const messageDelta: AnthropicStreamEvent = {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: 0,
    },
  };
  writeSseEvent(res, messageDelta);
  verbose(`[${requestId}] Sent message_delta event`);

  // Send message_stop event
  const messageStop: AnthropicStreamEvent = {
    type: 'message_stop',
  };
  writeSseEvent(res, messageStop);
  verbose(`[${requestId}] Sent message_stop event`);

  res.end();
  verbose(`[${requestId}] Response stream ended`);
}

/**
 * Send non-streaming Anthropic response
 */
async function sendAnthropicCompletionResponse(
  res: ServerResponse,
  response: vscode.LanguageModelChatResponse,
  modelName: string,
  requestId: string
): Promise<void> {
  const messageId = `msg_${Math.random().toString(36).slice(2)}`;
  verbose(`[${requestId}] Building non-streaming response, messageId=${messageId}`);
  const content: AnthropicContentBlock[] = [];
  let sawToolCall = false;

  for await (const part of response.stream) {
    if (isToolCallPart(part)) {
      sawToolCall = true;
      verbose(`[${requestId}] Collected tool call: name=${part.name}, callId=${part.callId}`);
      const toolBlock: AnthropicToolUseBlock = {
        type: 'tool_use',
        id: part.callId,
        name: part.name,
        input: part.input as Record<string, unknown>,
      };
      content.push(toolBlock);
    } else {
      const text = extractTextContent(part);
      if (text) {
        verbose(`[${requestId}] Collected text: ${text.length} chars`);
        const textBlock: AnthropicTextBlock = {
          type: 'text',
          text,
        };
        content.push(textBlock);
      }
    }
  }

  const stopReason: AnthropicStopReason = sawToolCall ? 'tool_use' : 'end_turn';
  verbose(`[${requestId}] Response complete: content_blocks=${content.length}, stop_reason=${stopReason}`);
  
  const anthropicResponse: AnthropicMessagesResponse = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model: modelName,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  verbose(`[${requestId}] Sending non-streaming response...`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResponse));
  verbose(`[${requestId}] Non-streaming response sent`);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resolve model from request
 */
async function resolveModel(
  requestedModel: string | undefined,
  res: ServerResponse
): Promise<vscode.LanguageModelChat | undefined> {
  const model = await getModel(false, requestedModel);
  if (model) {
    return model;
  }

  const hasLanguageModels = hasLMApi();
  if (requestedModel && hasLanguageModels) {
    writeErrorResponse(res, 404, 'model not found', 'invalid_request_error', 'model_not_found', 'not_found');
  } else {
    const reason = hasLanguageModels ? 'copilot_model_unavailable' : 'missing_language_model_api';
    writeErrorResponse(res, 503, 'Copilot unavailable', 'server_error', 'copilot_unavailable', reason);
  }
  return undefined;
}

/**
 * Write SSE event in Anthropic format
 * Note: Anthropic API uses simple SSE format without event types, just data payloads
 */
function writeSseEvent(res: ServerResponse, event: AnthropicStreamEvent): void {
  const eventType = event.type;
  const sseLine = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
  res.write(sseLine);
}

/**
 * Type guard for tool call parts
 */
function isToolCallPart(part: unknown): part is vscode.LanguageModelToolCallPart {
  return (
    part !== null &&
    typeof part === 'object' &&
    'callId' in part &&
    'name' in part &&
    'input' in part
  );
}

/**
 * Extract text content from stream part
 */
function extractTextContent(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }

  if (part !== null && typeof part === 'object' && 'value' in part) {
    return String((part as { value: unknown }).value) || '';
  }

  return '';
}

/**
 * Dispose response resources
 */
function disposeResponse(response: vscode.LanguageModelChatResponse): void {
  const disposable = response as { dispose?: () => void };
  if (typeof disposable.dispose === 'function') {
    disposable.dispose();
  }
}
