import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

/** Thin client for the FastAPI AI service. */
export async function callAI(path, body, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.aiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.aiKey ? { 'x-api-key': env.aiKey } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
      throw new HttpError(res.status === 422 ? 422 : 502, `AI service error: ${detail}`);
    }
    return data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.name === 'AbortError') throw new HttpError(504, 'AI service timed out');
    throw new HttpError(503, `AI service unreachable at ${env.aiUrl}. Start it with: cd ai-service && uvicorn app.main:app --port 8000`);
  } finally {
    clearTimeout(timer);
  }
}

export async function aiHealth() {
  try {
    const res = await fetch(`${env.aiUrl}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : { status: 'down' };
  } catch {
    return { status: 'down' };
  }
}
