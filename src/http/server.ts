import polka from 'polka';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import { getBridgeConfig } from '../config';
import { state } from '../state';
import { isAuthorized } from './auth';
import { handleHealthCheck } from './routes/health';
import { handleModelsRequest } from './routes/models';
import { handleChatCompletion } from './routes/chat';
import { handleAiSdkResponse } from './routes/responses';
import { writeErrorResponse, writeNotFound, writeRateLimit, writeTokenRequired, writeUnauthorized } from './utils';
import { ensureOutput, verbose } from '../log';
import { updateStatus } from '../status';
import { anthropicMessages } from './routes/anthropic';
import { handleGeminiGenerateContent } from './routes/gemini';

export const startServer = async (): Promise<void> => {
  if (state.server) return;
  const config = getBridgeConfig();
  ensureOutput();

  const app = polka({
    onError: (err, req, res) => {
      const msg = err instanceof Error ? err.message : String(err);
      verbose(`HTTP error: ${msg}`);
      if (!res.headersSent) {
        writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
      } else {
        try { res.end(); } catch {/* ignore */}
      }
    },
    onNoMatch: (_req, res) => {
      writeNotFound(res);
    },
  });

  // Auth middleware - runs before all routes (except /health)
  app.use((req, res, next) => {
    const path = req.url ?? '/';
    if (path === '/health') {
      return next();
    }
    const token = getBridgeConfig().token;
    if (!token) {
      if (config.verbose) {
        verbose('401 unauthorized: missing auth token');
      }
      writeTokenRequired(res);
      return;
    }
    if (!isAuthorized(req, token)) {
      writeUnauthorized(res);
      return;
    }
    next();
  });

  // Gemini API compatibility: intercept requests before route matching
  app.use(async (req: IncomingMessage, res: ServerResponse, next) => {
    const url = req.url || '';
    
    // Only intercept POST requests to /v1/models/{model}:generateContent
    if (req.method !== 'POST' || !url.startsWith('/v1/models/') || !url.match(/:(?:stream)?[gG]enerateContent/)) {
      return next();
    }

    if (config.verbose) {
      verbose(`Gemini API intercepted: ${url}`);
    }

    // Rate limiting check
    if (state.activeRequests >= config.maxConcurrent) {
      if (config.verbose) {
        verbose(`429 throttled (active=${state.activeRequests}, max=${config.maxConcurrent})`);
      }
      writeRateLimit(res);
      return;
    }

    try {
      // Extract model name from URL: /v1/models/{model}:generateContent?key=xxx
      const urlWithoutQuery = url.split('?')[0];
      const match = urlWithoutQuery.match(/\/v1\/models\/([^:]+):(?:stream)?[gG]enerateContent/);
      const modelName = match?.[1] || 'gpt-4o-copilot';

      if (config.verbose) {
        verbose(`Gemini API: ${url} -> model: ${modelName}`);
      }

      await handleGeminiGenerateContent(req, res, modelName);
      // Important: Return here to prevent calling next() and avoid double response
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (config.verbose) {
        verbose(`Gemini API error: ${msg}`);
      }
      // Only write error if headers haven't been sent
      if (!res.headersSent) {
        writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
      }
      return;
    }
  });

  // Verbose logging middleware
  if (config.verbose) {
    app.use((req, res, next) => {
      verbose(`${req.method} ${req.url}`);
      next();
    });
  }

  app.get('/health', async (_req: IncomingMessage, res: ServerResponse) => {
    await handleHealthCheck(res, config.verbose);
  });

  app.get('/v1/models', async (_req: IncomingMessage, res: ServerResponse) => {
    await handleModelsRequest(res);
  });

  app.post('/v1/chat/completions', async (req: IncomingMessage, res: ServerResponse) => {
    // Rate limiting check
    if (state.activeRequests >= config.maxConcurrent) {
      if (config.verbose) {
        verbose(`429 throttled (active=${state.activeRequests}, max=${config.maxConcurrent})`);
      }
      writeRateLimit(res);
      return;
    }
    
    try {
      await handleChatCompletion(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
    }
  });

  app.post('/v1/responses', async (req: IncomingMessage, res: ServerResponse) => {
    // Rate limiting check
    if (state.activeRequests >= config.maxConcurrent) {
      if (config.verbose) {
        verbose(`429 throttled (active=${state.activeRequests}, max=${config.maxConcurrent})`);
      }
      writeRateLimit(res);
      return;
    }
    
    try {
      await handleAiSdkResponse(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeErrorResponse(res, 500, msg || 'internal_error', 'server_error', 'internal_error');
    }
  });
  
  app.post('/v1/messages', anthropicMessages);

  await new Promise<void>((resolve, reject) => {
    try {
      app.listen(config.port, config.host, () => {
        const srv = app.server as Server | undefined;
        if (!srv) return reject(new Error('Server failed to start'));
        state.server = srv;
        updateStatus('start');
        resolve();
      });
      const srv = app.server as Server | undefined;
      srv?.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
};

export const stopServer = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (!state.server) return resolve();
    state.server.close(() => resolve());
  });
  state.server = undefined;
};
