import { StreamIdleTimeoutError } from "../provider-retry.js";

/** Turns a push-style sink into an async iterable: the consumer awaits events the producer pushes. */
export class ProviderTurnEventQueue<T> implements AsyncIterable<T> {
private readonly items: T[] = [];
private readonly waiters: Array<{
  resolve: (value: IteratorResult<T>) => void;
  reject: (reason?: unknown) => void;
}> = [];
private closed = false;
private error: unknown;

push(item: T): void {
  if (this.closed) return;
  const waiter = this.waiters.shift();
  if (waiter) {
    waiter.resolve({ value: item, done: false });
    return;
  }
  this.items.push(item);
}

close(): void {
  if (this.closed) return;
  this.closed = true;
  while (this.waiters.length > 0) {
    this.waiters.shift()?.resolve({ value: undefined as T, done: true });
  }
}

fail(error: unknown): void {
  if (this.closed) return;
  this.error = error;
  this.closed = true;
  while (this.waiters.length > 0) {
    this.waiters.shift()?.reject(error);
  }
}

[Symbol.asyncIterator](): AsyncIterator<T> {
  return {
    next: () => {
      if (this.items.length > 0) {
        return Promise.resolve({ value: this.items.shift() as T, done: false });
      }
      if (this.error !== undefined) return Promise.reject(this.error);
      if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
      return new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    },
  };
}
}

/** Splits a streamed response body into trimmed lines, failing a stream that goes quiet for `idleMs`. */
export async function* readResponseLines(
body: ReadableStream<Uint8Array>,
opts: { idleMs?: number } = {},
): AsyncGenerator<string> {
const reader  = body.getReader();
const decoder = new TextDecoder();
const idleMs  = opts.idleMs;
let buffer    = "";
try {
  while (true) {
    const read = reader.read();
    // A stalled provider (socket held open, no bytes) would otherwise hang the turn until
    // undici's coarse 300s body timeout. Race each read against a tighter idle timer so a
    // mid-stream stall becomes a prompt, surfaceable error. The timer resets on every chunk,
    // so an actively-streaming turn never trips it. Apply it to the first chunk too:
    // reasoning gets the full idle allowance, and flex requests get their longer bound.
    let result: Awaited<ReturnType<typeof reader.read>>;
    if (idleMs && idleMs > 0) {
      void read.catch(() => { /* settled via race/cancel below; avoid unhandledRejection */ });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StreamIdleTimeoutError(`No stream data for ${Math.round(idleMs / 1000)}s`)),
          idleMs,
        );
      });
      try {
        result = await Promise.race([read, idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      result = await read;
    }
    const { done, value } = result;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) yield buffer.trim();
} finally {
  try { await reader.cancel(); } catch { /* ignore */ }
  try { reader.releaseLock(); } catch { /* ignore */ }
}
}
