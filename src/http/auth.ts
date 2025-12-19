import type { IncomingMessage } from 'http';

// Cache the authorization header to avoid repeated concatenation
let cachedToken = '';
let cachedAuthHeader = '';

/**
 * Checks if the request is authorized against the configured token.
 * Caches the full "Bearer <token>" header to optimize hot path.
 */
export const isAuthorized = (req: IncomingMessage, token: string): boolean => {
  if (!token) {
    cachedToken = '';
    cachedAuthHeader = '';
    return false;
  }

  // Update cache if token changed
  if (token !== cachedToken) {
    cachedToken = token;
    cachedAuthHeader = `Bearer ${token}`;
  }

    // 检查 Authorization: Bearer <token>
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const provided = auth.slice(7).trim();
    if (provided === token) return true;
  }

  // 检查 x-api-key: <token>
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim() === token) {
    return true;
  }

  // 检查 x-goog-api-key: <token> (Gemini API)
  const xGoogApiKey = req.headers['x-goog-api-key'];
  if (typeof xGoogApiKey === 'string' && xGoogApiKey.trim() === token) {
    return true;
  }
  
  return false;
};
