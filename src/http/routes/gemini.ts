import type { IncomingMessage, ServerResponse } from 'http';
import { verbose } from '../../log';
import { getBridgeConfig } from '../../config';
import { writeErrorResponse } from '../utils';

/**
 * Gemini API request format
 */
interface GeminiContent {
  role?: string;
  parts: Array<{ text?: string }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
  tools?: unknown[];
}

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function getBearerToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  
  // Check query parameter 'key' (Google Gemini API standard)
  const url = req.url || '';
  const queryStart = url.indexOf('?');
  if (queryStart >= 0) {
    const queryString = url.substring(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const key = params.get('key');
    if (key) return key;
  }
  
  return null;
}

function getOrigin(req: IncomingMessage): string {
  const host = (req.headers['host'] as string) || '127.0.0.1:9527';
  return `http://${host}`;
}

/**
 * Handle Gemini API format: POST /v1/models/{model}:generateContent
 * Converts to OpenAI format, calls internal endpoint, and converts back to Gemini format
 */
export async function handleGeminiGenerateContent(
  req: IncomingMessage,
  res: ServerResponse,
  modelName: string
): Promise<void> {
  const config = getBridgeConfig();
  
  if (config.verbose) {
    verbose(`Gemini API request for model: ${modelName}`);
  }

  const token = getBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 
      error: { message: 'unauthorized', type: 'invalid_request_error', code: 'unauthorized' } 
    }));
    return;
  }

  // Read request body
  let geminiReq: GeminiRequest;
  try {
    const { readJson } = await import('../utils');
    geminiReq = await readJson(req) as GeminiRequest;
  } catch (e) {
    writeErrorResponse(res, 400, 'Invalid JSON', 'invalid_request_error', 'parse_error');
    return;
  }

  if (config.verbose) {
    verbose(`Gemini request: ${JSON.stringify(geminiReq).substring(0, 200)}...`);
  }

  // Convert Gemini format to OpenAI format
  const messages = geminiReq.contents?.map((content) => {
    const role = content.role === 'model' ? 'assistant' : (content.role || 'user');
    const textParts = content.parts?.filter(p => p.text).map(p => p.text).join('\n') || '';
    return {
      role,
      content: textParts
    };
  }) || [];

  // Build OpenAI-compatible request
  const openaiRequest = {
    model: modelName,
    messages,
    temperature: geminiReq.generationConfig?.temperature ?? 0.7,
    max_tokens: geminiReq.generationConfig?.maxOutputTokens,
    top_p: geminiReq.generationConfig?.topP,
    stream: false  // Currently only support non-streaming
  };

  if (config.verbose) {
    verbose(`Converted to OpenAI format: ${JSON.stringify(openaiRequest).substring(0, 200)}...`);
  }

  try {
    // Call internal /v1/chat/completions endpoint
    const origin = getOrigin(req);
    const resp = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(openaiRequest),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      if (resp.status === 401) {
        throw new Error(`Upstream /v1/chat/completions unauthorized: ${txt}`);
      }
      throw new Error(`Upstream /v1/chat/completions failed: ${resp.status} ${txt}`);
    }

    const openaiResponse = (await resp.json()) as OpenAIChatCompletion;
    
    // Convert OpenAI response to Gemini format
    const geminiResponse = {
      candidates: [{
        content: {
          parts: [{ text: openaiResponse.choices?.[0]?.message?.content || '' }],
          role: 'model'
        },
        finishReason: openaiResponse.choices?.[0]?.finish_reason?.toUpperCase() || 'STOP',
        index: 0
      }],
      usageMetadata: {
        promptTokenCount: openaiResponse.usage?.prompt_tokens || 0,
        candidatesTokenCount: openaiResponse.usage?.completion_tokens || 0,
        totalTokenCount: openaiResponse.usage?.total_tokens || 0
      }
    };

    if (config.verbose) {
      verbose(`Gemini response: ${JSON.stringify(geminiResponse).substring(0, 200)}...`);
    }

    // Send Gemini-formatted response
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(geminiResponse));
  } catch (err: any) {
    if (config.verbose) {
      verbose(`Gemini API error: ${err?.message}`);
    }
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: err?.message ?? 'Internal Server Error',
        type: 'server_error',
        code: 'gemini_conversion_error'
      }
    }));
  }
}
