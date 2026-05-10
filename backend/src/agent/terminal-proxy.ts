/**
 * Frozen seam — bug-fix only. No new features here.
 *
 * The Warp-UX successor lives in a separate Rust sidecar (see docs/ARCHITECTURE.md).
 */

/**
 * Terminal v2 reverse-proxy — exposes per-session ttyd instances through the
 * Atelier backend so the founder can use the terminal from any device that
 * can reach Atelier (LAN, tunnel, phone), not just the host machine.
 *
 * ttyd binds to 127.0.0.1 — that's the security boundary we want. Atelier
 * proxies HTTP + WS through the existing auth-gated backend, so anyone with a
 * cookie hits the proxy, the proxy hits ttyd locally.
 *
 * Path scheme:   /terminal-v2/proxy/<sessionId>/<remainder>
 *   • <remainder> == "" or "index.html" or "ws" — anything ttyd serves.
 *   • Backend strips the prefix and forwards <remainder> to 127.0.0.1:<port>.
 *
 * ttyd's bundled HTML uses relative asset paths and computes the WS URL from
 * `location.pathname + 'ws'`. So the iframe at /terminal-v2/proxy/<sid>/ works
 * automatically — ttyd doesn't need a `--base-path` flag.
 *
 * The HTTP proxy is straightforward fetch-passthrough. The WS proxy needs to
 * open an upstream WebSocket BEFORE upgrading the client connection, then
 * bridge messages both ways. ttyd uses Sec-WebSocket-Protocol: "tty" — we
 * forward that on both sides of the bridge.
 */

import { getTerminalV2 } from "./terminal-server";

const PROXY_PREFIX = "/terminal-v2/proxy/";

export interface ParsedProxyPath {
  sessionId: string;
  /** Path beyond the session prefix, e.g. "" | "index.html" | "ws" | "favicon.ico". */
  remainder: string;
}

/**
 * Parse `/terminal-v2/proxy/<sid>/...` into (sessionId, remainder).
 * Returns null if `path` is not a proxy path.
 */
export function parseProxyPath(path: string): ParsedProxyPath | null {
  if (!path.startsWith(PROXY_PREFIX)) return null;
  const tail = path.slice(PROXY_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash < 0) {
    // /terminal-v2/proxy/<sid> with no trailing slash — redirect-worthy, but
    // we treat as "" remainder so iframe loads cleanly.
    return { sessionId: tail, remainder: "" };
  }
  const sessionId = tail.slice(0, slash);
  const remainder = tail.slice(slash + 1);
  if (!sessionId) return null;
  return { sessionId, remainder };
}

/**
 * Forward an HTTP request to the local ttyd instance backing this session.
 * Returns null if the path isn't a proxy path so the caller can keep
 * matching downstream routes.
 */
export async function handleTerminalProxyHttp(req: Request, url: URL): Promise<Response | null> {
  const parsed = parseProxyPath(url.pathname);
  if (!parsed) return null;

  // The /ws upgrade is handled separately at the Bun.serve level; if a plain
  // HTTP GET reaches /ws here it's malformed and we return 426.
  if (parsed.remainder === "ws") {
    return new Response("upgrade required", { status: 426 });
  }

  const session = getTerminalV2(parsed.sessionId);
  if (!session) {
    return new Response("no active terminal-v2 for session", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Reconstruct the upstream URL: ttyd serves at root on its bound port,
  // so we forward /<remainder> + the original querystring.
  const upstreamUrl = `http://127.0.0.1:${session.ttydPort}/${parsed.remainder}${url.search}`;

  // Forward headers minus the hop-by-hop ones. We deliberately keep
  // accept-language / cookies stripped — ttyd doesn't auth, the cookie was
  // already validated upstream by Atelier's auth gate.
  const fwdHeaders = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const kl = k.toLowerCase();
    if (kl === "host" || kl === "connection" || kl === "keep-alive" || kl === "cookie") continue;
    if (kl === "upgrade" || kl === "sec-websocket-key" || kl === "sec-websocket-version") continue;
    if (kl === "sec-websocket-protocol" || kl === "sec-websocket-extensions") continue;
    if (kl === "accept-encoding") continue; // we want ttyd uncompressed; Bun would auto-decode anyway and lying about content-encoding breaks the browser
    fwdHeaders.set(k, v);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      // @ts-expect-error — Bun supports duplex but the lib type lags
      duplex: "half",
      redirect: "manual",
    });
    // Strip hop-by-hop response headers AND content-encoding / content-length:
    // Bun's fetch auto-decompresses gzip/br bodies before we get them, so passing
    // the original content-encoding header through would tell the browser to
    // re-decompress an already-decompressed body — which fails silently and
    // leaves the iframe blank (the ttyd black-screen bug).
    const respHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (
        kl === "connection" ||
        kl === "keep-alive" ||
        kl === "transfer-encoding" ||
        kl === "content-encoding" ||
        kl === "content-length"
      ) return;
      respHeaders.set(k, v);
    });
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (e) {
    return new Response(`ttyd upstream error: ${String(e).slice(0, 200)}`, { status: 502 });
  }
}

/**
 * Per-WS bridge state kept in Bun's `WebSocket.data`. Holds the upstream
 * client socket so the server-side handlers can route messages.
 */
export interface ProxyWsData {
  proxy: true;
  sessionId: string;
  upstream: WebSocket;
  /** Buffered client → upstream frames sent before upstream finished its handshake. */
  pendingToUpstream: (string | ArrayBuffer | Uint8Array)[];
  /** Buffered upstream → client frames received before Bun finished the client upgrade.
   *  ttyd sends its initial config/theme/window-size frames the instant the upstream
   *  WS opens — without this buffer they were dropped, leaving xterm.js stuck waiting
   *  for a config that already passed. */
  pendingToClient: (string | Uint8Array)[];
  clientReady: boolean;
  /** Set in openProxyBridge once the server-side WebSocket is upgraded. The eager
   *  upstream message listener uses this to send vs. buffer. */
  serverWs: import("bun").ServerWebSocket<ProxyWsData> | null;
}

/**
 * Open the upstream WS to ttyd and return the data object Bun should attach to
 * the upgraded client socket. Returns null if the session isn't active.
 *
 * Critically, the upstream message listener is attached EAGERLY here — not in
 * openProxyBridge — because ttyd emits its initial config frames immediately
 * on WS open and Bun's client upgrade may not finish in time. Frames received
 * before clientReady are buffered into pendingToClient and flushed once the
 * client is ready.
 */
export function startUpstreamWs(sessionId: string, subprotocol: string | null): ProxyWsData | null {
  const session = getTerminalV2(sessionId);
  if (!session) return null;
  const upstreamUrl = `ws://127.0.0.1:${session.ttydPort}/ws`;
  const upstream = subprotocol
    ? new WebSocket(upstreamUrl, [subprotocol])
    : new WebSocket(upstreamUrl);
  upstream.binaryType = "arraybuffer";

  const data: ProxyWsData = {
    proxy: true,
    sessionId,
    upstream,
    pendingToUpstream: [],
    pendingToClient: [],
    clientReady: false,
    serverWs: null,
  };

  upstream.addEventListener("message", (ev: MessageEvent) => {
    const payload = ev.data;
    let toSend: string | Uint8Array | null = null;
    if (typeof payload === "string") toSend = payload;
    else if (payload instanceof ArrayBuffer) toSend = new Uint8Array(payload);
    else if (payload instanceof Uint8Array) toSend = payload;
    else if ((payload as { arrayBuffer?: () => Promise<ArrayBuffer> })?.arrayBuffer) {
      (payload as Blob).arrayBuffer().then((buf) => {
        const u = new Uint8Array(buf);
        if (data.clientReady && data.serverWs && data.serverWs.readyState === 1) {
          data.serverWs.send(u);
        } else {
          data.pendingToClient.push(u);
        }
      });
      return;
    } else return;
    if (data.clientReady && data.serverWs && data.serverWs.readyState === 1) {
      data.serverWs.send(toSend);
    } else {
      data.pendingToClient.push(toSend);
    }
  });

  upstream.addEventListener("close", () => {
    if (data.serverWs) {
      try { data.serverWs.close(); } catch { /* ignore */ }
    }
  });
  upstream.addEventListener("error", () => {
    if (data.serverWs) {
      try { data.serverWs.close(1011, "ttyd upstream error"); } catch { /* ignore */ }
    }
  });

  return data;
}
