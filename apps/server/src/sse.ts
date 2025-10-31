import type { Response } from "express";

export interface SSEChannel {
  send: (event: string, data: unknown) => boolean;
  close: () => void;
}

/**
 * Open a robust SSE channel with anti-buffering and backpressure handling
 *
 * Features:
 * - Explicit no-cache, no-transform headers
 * - Disables proxy buffering (Nginx X-Accel-Buffering)
 * - TCP NoDelay for immediate packet sending
 * - Keepalive heartbeat every 15s
 * - Proper cleanup on close/error
 */
export function openSSE(res: Response): SSEChannel {
  // 1) SSE headers + anti-buffering
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform"); // no-transform prevents proxy "optimization"
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Nginx: disable proxy buffering
  res.setHeader("Transfer-Encoding", "chunked"); // explicit (normally implicit in HTTP/1.1)

  // 2) Flush headers immediately
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  // 3) TCP: send small chunks without waiting (Nagle's algorithm off)
  if (res.socket && typeof res.socket.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }

  // 3b) Keep socket alive to prevent premature closure
  if (res.socket && typeof res.socket.setKeepAlive === "function") {
    res.socket.setKeepAlive(true);
  }

  // 4) Keepalive heartbeat every 15s to prevent timeouts
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`:hb ${Date.now()}\n\n`);
    }
  }, 15000);

  let closed = false;

  // Cleanup handler
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      if (!res.writableEnded) {
        res.end();
      }
    } catch (error) {
      // Ignore errors on close
    }
  };

  res.on("close", close);
  res.on("error", close);

  /**
   * Send an SSE event
   * @param event Event name
   * @param data Event data (will be JSON stringified)
   * @returns true if buffer is empty (can continue writing), false if backpressure (should pause source)
   */
  const send = (event: string, data: unknown): boolean => {
    if (closed || res.writableEnded) {
      return false;
    }

    try {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      // SSE format: event: <name>\ndata: <payload>\n\n
      return res.write(`event: ${event}\ndata: ${payload}\n\n`);
    } catch (error) {
      close();
      return false;
    }
  };

  return { send, close };
}
