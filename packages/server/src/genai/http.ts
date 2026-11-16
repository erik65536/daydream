/**
 * HTTP for the model gateway: OpenAI, transcription, and ComfyUI (through the GPU broker) all send through here.
 *
 * A kept-alive connection can be closed by the server at the moment a request is written to it: the server's idle
 * timer fires as the request arrives, and the request is answered with a reset. Undici resends only GET-like
 * requests, and every model call is a POST. Here a request whose connection was lost before any response arrived is
 * sent once more at once, on a new connection; only a second failure reaches the caller (and the gateway's retry
 * with backoff in service.ts). Browsers resend only on a reused connection; this resends on a new one too, which
 * costs nothing new, since the gateway would resend that request after its backoff anyway.
 */
import { Agent, FormData as UndiciFormData, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * A flex-tier answer with long reasoning can take many minutes before the first byte when it is not streamed, so the default
 * 300 s header timeout of Node's fetch is disabled; the caller's abort signal is the only limit.
 */
export const patientAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } });

/** The connection broke before a response: reset, closed by the other side, or written after it closed. */
export function connectionLost(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return e instanceof TypeError && ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(cause?.code ?? '');
}

/** fetch, sent once more on a new connection if the first one was lost before any response. */
export async function sendRequest(url: string, init: RequestInit & { dispatcher?: Dispatcher } = {}): Promise<Response> {
  // Undici's fetch sends Node's own FormData as the text "[object FormData]": copy it into undici's.
  let body = init.body;
  if (body instanceof FormData) {
    const form = new UndiciFormData();
    for (const [k, v] of body) form.append(k, v as never);
    body = form as never;
  }
  const send = () => undiciFetch(url, { ...init, body } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  try {
    return await send();
  } catch (e) {
    if (!connectionLost(e) || init.signal?.aborted) throw e;
    return send();
  }
}
