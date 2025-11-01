import bodyParser from "body-parser";
import cors from "cors";
import express, { Response } from "express";
import { AuditTrail, AuditEvent } from "@mind-membrane/audit-u4";
import { createCitizenTool } from "@mind-membrane/tools-citizens";
import { createTerminalTool } from "@mind-membrane/tools-terminal";
import { openSSE } from "./sse";
import { terminalExecuteDirect } from "./handlers/terminal-execute";

const PORT = Number(process.env.PORT ?? 8787);
// The current MCP protocol version supported by ChatGPT connectors.
// Using an unknown future version causes ChatGPT to refuse the connection,
// so we align with the latest published spec.
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mind-membrane", version: "0.1.0" } as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id?: string | number;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SseClient {
  res: Response;
  heartbeat: NodeJS.Timeout;
}

const app = express();
const auditTrail = new AuditTrail();

const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const bearerToken = process.env.MCP_BEARER_TOKEN;

app.use((req, res, next) => {
  res.setHeader("MCP-Protocol-Version", PROTOCOL_VERSION);
  const origin = req.headers.origin;
  if (allowedOrigins.length > 0) {
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
  }
  if (bearerToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== bearerToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : undefined, credentials: true }));
app.use(bodyParser.json({ limit: "1mb" }));

const sseClients: SseClient[] = [];

function registerSse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(
    `data: ${JSON.stringify({ jsonrpc: "2.0", method: "audit/publicKey", params: { key: auditTrail.getPublicKey() } })}\n\n`
  );
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 15000);
  const client: SseClient = { res, heartbeat };
  sseClients.push(client);
  res.on("close", () => {
    clearInterval(heartbeat);
    const index = sseClients.indexOf(client);
    if (index >= 0) {
      sseClients.splice(index, 1);
    }
  });
}

function broadcastNotification(method: string, params: unknown) {
  const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
  for (const client of sseClients) {
    client.res.write(`data: ${payload}\n\n`);
  }
}

function broadcastAudit(event: AuditEvent) {
  broadcastNotification("audit/event", event);
}

auditTrail.on("event", (event: AuditEvent) => broadcastAudit(event));

const terminalTool = createTerminalTool({ auditTrail });
const citizenTool = createCitizenTool({ auditTrail });

const toolsRegistry = [terminalTool, citizenTool];

function buildToolsList() {
  return toolsRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

function sendJsonRpc(res: Response, response: JsonRpcResponse) {
  res.json(response);
}

function handleInitialize(request: JsonRpcRequest, res: Response) {
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: true },
      logging: {}
    },
    serverInfo: SERVER_INFO
  };
  const response: JsonRpcResponse = { jsonrpc: "2.0", id: request.id, result };
  sendJsonRpc(res, response);
  broadcastNotification("notifications/initialized", { serverInfo: SERVER_INFO });
}

function handleToolsList(request: JsonRpcRequest, res: Response) {
  const result = {
    tools: buildToolsList()
  };
  const response: JsonRpcResponse = { jsonrpc: "2.0", id: request.id, result };
  sendJsonRpc(res, response);
}

async function handleToolsCall(request: JsonRpcRequest, res: Response) {
  const params = request.params ?? {};
  const name = params.name;
  const args = params.arguments;

  // HOTFIX: Route terminal.run execute mode to direct PTY handler
  // This bypasses EventEmitter abstraction to eliminate scope/timing issues
  if (name === "terminal.run" && args?.mode === "execute" && args?.approved === true) {
    return terminalExecuteDirect(args, res);
  }

  const tool = toolsRegistry.find((item) => item.name === name);
  if (!tool) {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Unknown tool ${String(name)}` }
    };
    return sendJsonRpc(res, response);
  }
  const result = await tool.call(args);
  if (result.mode === "plan") {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          {
            type: "text",
            text: `Plan approved? ${result.requiresApproval}\n${result.summary}`
          }
        ],
        policy: result.evaluation
      }
    };
    return sendJsonRpc(res, response);
  }
  if (result.mode === "denied") {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          {
            type: "text",
            text: `Request denied: ${result.evaluation.reasons.join(", ")}`
          }
        ],
        policy: result.evaluation
      }
    };
    return sendJsonRpc(res, response);
  }

  // Open robust SSE channel with anti-buffering
  const sse = openSSE(res);
  const emitter = result.emitter;
  const ptyInstance = (result as any).pty; // PTY instance for backpressure control

  // Send initial "started" event for immediate feedback
  sse.send("started", {
    jsonrpc: "2.0",
    method: "tools/call/started",
    params: { id: request.id, timestamp: Date.now() }
  });

  // Backpressure: pause PTY when socket buffer is full, resume on drain
  let paused = false;
  if (ptyInstance) {
    res.on("drain", () => {
      if (paused && ptyInstance) {
        ptyInstance.resume();
        paused = false;
      }
    });
  }

  const cleanup = () => {
    emitter.removeListener("event", onEvent);
    sse.close();
  };

  const onEvent = (event: any) => {
    // Stream the event with backpressure handling
    const ok = sse.send("stream", {
      jsonrpc: "2.0",
      method: "tools/call/stream",
      params: { event }
    });

    // If buffer is full, pause PTY until drain
    if (!ok && !paused && ptyInstance) {
      ptyInstance.pause();
      paused = true;
    }

    if (event?.type === "exit") {
      const finalResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `Process exited with code ${event.exitCode}`
            }
          ],
          policy: result.evaluation
        }
      };
      sse.send("result", finalResponse);
      cleanup();
    }

    if (event?.type === "error") {
      const finalResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `Execution error: ${event.data}`
            }
          ],
          policy: result.evaluation
        }
      };
      sse.send("result", finalResponse);
      cleanup();
    }
  };

  emitter.on("event", onEvent);
  res.on("close", cleanup);
}

const handlers: Record<string, (request: JsonRpcRequest, res: Response) => void | Promise<void>> = {
  initialize: handleInitialize,
  "tools/list": handleToolsList,
  "tools/call": (request, res) => handleToolsCall(request, res)
};

app.get("/mcp", (_req, res) => {
  registerSse(res);
});

app.post("/mcp", async (req, res) => {
  const body = req.body as JsonRpcRequest;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return res.status(400).json({ error: "Invalid JSON-RPC request" });
  }
  const handler = handlers[body.method];
  if (!handler) {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" }
    };
    return sendJsonRpc(res, response);
  }
  await handler(body, res);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mind Membrane MCP server listening on port ${PORT}`);
});
