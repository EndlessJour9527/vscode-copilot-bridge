import { IncomingMessage, ServerResponse } from 'http';
import { readJson, writeJson, writeErrorResponse } from '../utils';
import { verbose } from '../../log';

/**
 * Handles the /v1/messages/count_tokens endpoint (Anthropic-style).
 * This is a lightweight estimator, not a model-accurate tokenizer.
 */
export async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req);

    // Basic validation: expect messages array
    if (!body || !Array.isArray((body as any).messages)) {
      writeErrorResponse(res, 400, 'invalid request', 'invalid_request_error', 'invalid_payload');
      return;
    }

    verbose(`Count tokens request: ${JSON.stringify((body as any).messages)}`);

    const messages = (body as any).messages as Array<{ role?: string; content?: unknown }>;

    // Extract text content from messages (supports string content or content blocks with {type:'text',text})
    const textChunks: string[] = [];
    for (const msg of messages) {
      const { content } = msg || {};
      if (typeof content === 'string') {
        textChunks.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
            textChunks.push((block as any).text);
          }
        }
      }
    }

    const joined = textChunks.join(' ');
    // Simple heuristic: whitespace tokenization
    const inputTokens = joined.split(/\s+/).filter(Boolean).length;

    const response = {
      input_tokens: inputTokens,
      output_tokens: 0,
      total_tokens: inputTokens,
    };

    writeJson(res, 200, response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
  }
}