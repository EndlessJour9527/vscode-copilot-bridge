import * as vscode from 'vscode';
import type { IncomingMessage, ServerResponse } from 'http';
import { readJson, writeErrorResponse, writeJson } from '../utils';
import { getModel, hasLMApi } from '../../models';
import { getBridgeConfig } from '../../config';
import { verbose } from '../../log';

type ClaudeContentPart = { type: string; text?: string };

interface ClaudeCodeMessage {
	role: 'user' | 'assistant' | 'system';
	content: string | ClaudeContentPart[];
}

interface ClaudeCodeRequest {
	model: string;
	messages: ClaudeCodeMessage[];
	stream?: boolean;
}

interface ClaudeCodeResponse {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: { role: 'assistant'; content: string | null };
		finish_reason: 'stop';
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

const SSE_HEADERS = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
} as const;

function isClaudeCodeRequest(body: unknown): body is ClaudeCodeRequest {
	if (!body || typeof body !== 'object') return false;
	const obj = body as Record<string, unknown>;
	if (typeof obj.model !== 'string' || !Array.isArray(obj.messages)) return false;
	// verbose(`Checking ClaudeCodeRequest messages${JSON.stringify(obj.messages)}`);
	return obj.messages.every((m) => {
		if (!m || typeof m !== 'object') return false;
		const role = (m as ClaudeCodeMessage).role;
		const content = (m as ClaudeCodeMessage).content;
		const roleOk = role === 'user' || role === 'assistant' || role === 'system';
		const contentOk =
			typeof content === 'string' ||
			(Array.isArray(content) && content.every((p) => p && typeof p === 'object' && 'type' in p));
		return roleOk && contentOk;
	});
}

function flattenContent(content: string | ClaudeContentPart[]): string {
	if (typeof content === 'string') return content;
	return content
		.filter((p) => typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text as string)
		.join('');
}

function convertMessagesToLM(messages: ClaudeCodeMessage[]): vscode.LanguageModelChatMessage[] {
	return messages.map((m) => {
		const text = flattenContent(m.content) ?? '';
		switch (m.role) {
			case 'assistant':
				return vscode.LanguageModelChatMessage.Assistant(text);
			case 'system':
				return vscode.LanguageModelChatMessage.User(text);
			case 'user':
			default:
				return vscode.LanguageModelChatMessage.User(text);
		}
	});
}

function createChunk(id: string, model: string, created: number, delta: string | null, finish: 'stop' | null) {
	return {
		id,
		object: 'chat.completion.chunk',
		created,
		model,
		choices: [
			{
				index: 0,
				delta: delta ? { content: delta, role: 'assistant' } : { role: 'assistant' },
				finish_reason: finish,
			},
		],
	};
}

function extractText(part: unknown): string {
	if (typeof part === 'string') return part;
	if (part && typeof part === 'object' && 'value' in part) {
		return String((part as { value: unknown }).value ?? '');
	}
	return '';
}

function writeAnthropicEvent(res: ServerResponse, event: string, data: object) {
	verbose(`Sending event: ${event} data: ${JSON.stringify(data).slice(0, 200)}`);
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleClaudeCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const requestId = `chatcmpl-${Math.random().toString(36).slice(2)}`;
	
	try {
		const body = await readJson(req);
		verbose(`Claude code request started id=${requestId}: ${JSON.stringify(body).slice(0, 500)}`);
		if (!isClaudeCodeRequest(body)) {
			verbose(`Claude code invalid payload id=${requestId}: ${JSON.stringify(body)}`);
			writeErrorResponse(res, 400, 'invalid request', 'invalid_request_error', 'invalid_payload');
			return;
		}

		const model = await getModel(false, body.model);
		if (!model) {
			const hasLm = hasLMApi();
			if (body.model && hasLm) {
				writeErrorResponse(res, 404, 'model not found', 'invalid_request_error', 'model_not_found', 'not_found');
			} else {
				const reason = hasLm ? 'copilot_model_unavailable' : 'missing_language_model_api';
				writeErrorResponse(res, 503, 'Copilot unavailable', 'server_error', 'copilot_unavailable', reason);
			}
			return;
		}

		const config = getBridgeConfig();
		const lmMessages = convertMessagesToLM(body.messages).slice(-config.historyWindow * 2);

		const cancellationToken = new vscode.CancellationTokenSource();
		try {
			const response = await model.sendRequest(lmMessages as vscode.LanguageModelChatMessage[], {}, cancellationToken.token);
			const created = Math.floor(Date.now() / 1000);

			if (body.stream === false) {
				let content = '';
				for await (const part of response.stream) {
					content += extractText(part);
				}

				const normalized = content.trim();
				const payload: ClaudeCodeResponse = {
					id: requestId,
					object: 'chat.completion',
					created,
					model: body.model,
					choices: [
						{
							index: 0,
							message: { role: 'assistant', content: normalized },
							finish_reason: 'stop',
						},
					],
					usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
				};

				writeJson(res, 200, payload);
				return;
			}

			// streaming path (Anthropic beta /v1/messages format)
			if (res.socket) {
				res.socket.setNoDelay(true);
			}
			verbose(`Claude code streaming start id=${requestId} model=${body.model} msgs=${lmMessages.length}`);
			res.writeHead(200, SSE_HEADERS);
			if (typeof res.flushHeaders === 'function') {
				res.flushHeaders();
			}

			// Anthropic SSE event sequence
			writeAnthropicEvent(res, 'message_start', {
				type: 'message_start',
				message: {
					id: requestId,
					type: 'message',
					role: 'assistant',
					model: body.model,
					content: [],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			});
			writeAnthropicEvent(res, 'content_block_start', {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'text', text: '' },
			});

			let hasDelta = false;
			for await (const part of response.stream) {
				const text = extractText(part);
				if (!text) continue;
				hasDelta = true;
				writeAnthropicEvent(res, 'content_block_delta', {
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text },
				});
			}

			if (!hasDelta) {
				writeAnthropicEvent(res, 'content_block_delta', {
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'text_delta', text: '' },
				});
			}

			writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
			writeAnthropicEvent(res, 'message_delta', {
				type: 'message_delta',
				delta: {
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			});
			writeAnthropicEvent(res, 'message_stop', {
				type: 'message_stop',
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				message: {
					id: requestId,
					type: 'message',
					role: 'assistant',
					model: body.model,
					content: [],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			});
			res.end();
		} finally {
			cancellationToken.dispose();
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const isConnRefused = typeof msg === 'string' && msg.includes('ERR_CONNECTION_REFUSED');
		verbose(`Claude code error id=${requestId}: ${msg}`);
		if (res.headersSent) {
			try { res.end(); } catch { /* ignore */ }
			return;
		}
		const status = isConnRefused ? 503 : 500;
		const code = isConnRefused ? 'connection_refused' : 'internal_error';
		if (isConnRefused) {
			writeErrorResponse(res, status, msg || code, 'server_error', code, 'connection_refused');
		} else {
			writeErrorResponse(res, status, msg || code, 'server_error', code);
		}
	} finally {
		verbose(`Claude code request ended id=${requestId}`);
	}
}
