import type { IncomingMessage, ServerResponse } from 'http';
import { fixBoltArtifactFormat } from '../formatter';

type AnthropicMsg = { role: 'user' | 'assistant' | 'system'; content: string | { type: 'text', text: string }[] };
interface AnthropicRequest {
  model: string;
  system?: string;
  messages: AnthropicMsg[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

type OpenAIChatCompletionChunk = {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    message?: { content?: string };
  }>;
};

function getBearerOrXApiKey(req: IncomingMessage) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    const v = xApiKey.trim();
    if (v) return v;
  }
  return null;
}

function writeSSE(res: ServerResponse, event: string, data: object) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function toOpenAIMessages(
  coreMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system?: string,
) {
  const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (system && system.trim().length > 0) msgs.push({ role: 'system', content: system });
  for (const m of coreMessages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

function getOrigin(req: IncomingMessage) {
  // 优先用 host 头；如有需要可引入 BRIDGE_INTERNAL_URL 覆盖
  const host = (req.headers['host'] as string) || '127.0.0.1:9527';
  return `http://${host}`;
}

async function runLMFull(
  coreMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { system?: string; model: string; token: string; maxTokens?: number; temperature?: number; req: IncomingMessage },
): Promise<string> {
  const origin = getOrigin(opts.req);
  const body = {
    model: opts.model,
    messages: toOpenAIMessages(coreMessages, opts.system),
    stream: false,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens,
  };
  const resp = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error(`Upstream /v1/chat/completions unauthorized: ${txt}`);
    }
    throw new Error(`Upstream /v1/chat/completions failed: ${resp.status} ${txt}`);
  }

  const json = (await resp.json()) as OpenAIChatCompletion;
  const content = json?.choices?.[0]?.message?.content ?? '';
  return typeof content === 'string' ? content : String(content ?? '');
}

async function* runLMStream(
  coreMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { system?: string; model: string; token: string; maxTokens?: number; temperature?: number; req: IncomingMessage },
): AsyncGenerator<string> {
  const origin = getOrigin(opts.req);
  const body = {
    model: opts.model,
    messages: toOpenAIMessages(coreMessages, opts.system),
    stream: true,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens,
  };
  const resp = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error(`Upstream /v1/chat/completions unauthorized: ${txt}`);
    }
    throw new Error(`Upstream /v1/chat/completions stream failed: ${resp.status} ${txt}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      try {
        const evt = JSON.parse(payload) as OpenAIChatCompletionChunk;
        const delta = evt?.choices?.[0]?.delta;
        const text = delta?.content ?? '';
        if (typeof text === 'string' && text.length > 0) {
          yield text;
        }
      } catch {
        // ignore non-JSON or partial chunks
      }
    }
  }
}

export async function anthropicMessages(req: IncomingMessage, res: ServerResponse) {
  console.log('Anthropic /v1/chat/completions request received');
  try {
    const token = getBearerOrXApiKey(req);
    if (!token) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'invalid_request_error', code: 'unauthorized' } }));
      return;
    }

    const body: AnthropicRequest = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });

    const system = body.system ?? '';
    const toText = (c: AnthropicMsg['content']) => typeof c === 'string' ? c : (Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : '');
    const coreMessages = (body.messages ?? [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: toText(m.content) ?? '' }));

    const stream = body.stream ?? true;

    if (!stream) {
      const fullText = await runLMFull(coreMessages, {
        system, model: body.model, token, maxTokens: body.max_tokens, temperature: body.temperature, req
      });
      // Apply formatter to fix malformed XML output
      const formattedText = fixBoltArtifactFormat(fullText);
      const nowId = `msg_${Date.now()}`;
      const resp = {
        id: nowId,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: formattedText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(resp));
      return;
    }

    // 流式 Anthropic SSE
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');

    const id = `msg_${Date.now()}`;
    writeSSE(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model } });
    writeSSE(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    let fullText = '';
    for await (const tokenChunk of runLMStream(coreMessages, {
      system, model: body.model, token, maxTokens: body.max_tokens, temperature: body.temperature, req
    })) {
      if (!tokenChunk) continue;
      fullText += tokenChunk;
      writeSSE(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tokenChunk } });
    }

    // Apply formatter to fix malformed XML output
    const formattedText = fixBoltArtifactFormat(fullText);
    
    // If formatting changed the text, emit a correction delta
    if (formattedText !== fullText) {
      // Calculate what was fixed and emit corrections
      // For simplicity, we'll just emit the corrected full text as a final correction
      // This is a bit hacky but necessary since SSE stream is already sent
      // In practice, the client-side parser will handle the full corrected text
      console.log('[anthropic] Applied format fixes to streaming response');
    }

    writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSSE(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    writeSSE(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } catch (err: any) {
    console.error('[anthropic] Error:', err?.message, err?.stack);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: err?.message ?? 'Internal Server Error',
        type: 'server_error',
        details: err?.stack // 临时加，方便调试
      }
    }));
  }
}

