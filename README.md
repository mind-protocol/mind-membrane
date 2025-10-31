# Mind Membrane MCP Server

This repository provides a Model Context Protocol (MCP) server that exposes two
high-assurance tools over the Streamable HTTP transport:

- **`terminal.run`** – plan and execute commands through a policy-controlled
  Windows PTY (ConPTY) surface.
- **`citizen.call`** – call a Mind citizen inside WSL using the `claude` CLI.

Both tools are guarded by Law-at-L4 validation rules and emit auditable events
signed with Ed25519 and chained with BLAKE3.

## Structure

- `apps/server` – Streamable HTTP MCP server.
- `packages/tools-terminal` – PTY-backed `terminal.run` implementation.
- `packages/tools-citizens` – WSL `citizen.call` bridge.
- `packages/l4` – Schemas, allowlists, and policy evaluation helpers.
- `packages/audit-u4` – Hash-chained, signed audit trail utilities.
- `infra/` – Reserved for tunnel scripts and deployment assets.

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

   > In environments without internet access, installation can be skipped, but
   > the server binaries will not build until packages are available.

2. **Build all packages**

   ```bash
   npm run build --workspaces
   ```

3. **Start the server**

   ```bash
   npm start
   ```

   The server listens on `http://127.0.0.1:8787/mcp` by default.

4. **Expose HTTPS**

   Use a tunnel provider such as ngrok or Cloudflare Tunnel to provide an HTTPS
   endpoint. The public URL must point to `/mcp` for ChatGPT connectors.

   ```bash
   ngrok http http://127.0.0.1:8787
   ```

5. **Register the connector in ChatGPT**

   - Open **Settings → Connectors**.
   - Choose **Add a connector** and paste the HTTPS URL ending with `/mcp`.
   - After saving, the `terminal.run` and `citizen.call` tools appear in the
     connector capabilities list.

## Configuration

Environment variables supported by the server:

- `PORT` – HTTP port (default `8787`).
- `MCP_ALLOWED_ORIGINS` – Comma-separated list of allowed `Origin` headers.
- `MCP_BEARER_TOKEN` – Optional Bearer token required on all requests.

## JSON-RPC examples

List available tools:

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Plan a terminal command:

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"terminal.run","arguments":{"bin":"git","args":["status"],"mode":"plan"}}}'
```

Stream an execution (requires an SSE-capable client):

```bash
curl -N -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"terminal.run","arguments":{"bin":"git","args":["--version"],"mode":"execute","approved":true}}}'
```

## Development notes

- Every execution emits signed audit events that can be consumed by opening a
  `GET /mcp` SSE stream.
- Policies deny any command that is not explicitly allowlisted or that contains
  shell metacharacters such as `&&`, `|`, or backticks.
- `terminal.run` requires `approved: true` when `mode` is `execute` to enforce a
  plan → approve → execute workflow.
- The `citizen.call` tool expects the `claude` CLI to be available within the
  target WSL distribution and will surface descriptive errors when it is not.
