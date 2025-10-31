# Mind Membrane MCP Server - Deployment Guide

## Architecture

```
ChatGPT → HTTPS (ngrok tunnel) → 127.0.0.1:8787 (WSL MCP Server)
                                       ↓
                         Bearer Auth + Origin Check (L4)
                                       ↓
                         terminal.run / citizen.call
                                       ↓
                            Linux-native PTY (node-pty)
```

## Prerequisites

- WSL2 with systemd enabled
- Node.js 18+ installed
- ngrok account with authtoken
- Mind Membrane built (`npm run build`)

## Installation

### 1. Configure Environment

```bash
# Copy production env template
cp .env.mcp ~/.env.mcp

# Generate new Bearer token (IMPORTANT: rotate in production!)
openssl rand -base64 32

# Edit ~/.env.mcp with your token and settings
```

### 2. Install systemd Service

```bash
# Copy service file
sudo cp infra/systemd/mind-membrane.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start service
sudo systemctl enable mind-membrane
sudo systemctl start mind-membrane

# Check status
sudo systemctl status mind-membrane

# View logs
journalctl -u mind-membrane -f
```

### 3. Configure ngrok Tunnel

```bash
# Add authtoken (one-time)
ngrok config add-authtoken YOUR_AUTHTOKEN

# Start tunnel (fixed domain)
ngrok http http://127.0.0.1:8787

# Your fixed URL: https://trusted-magpie-social.ngrok.app
```

### 4. Configure ChatGPT Connector

1. Go to ChatGPT Settings → Connectors → Add
2. Name: `Mind Membrane (L4)`
3. MCP Server URL: `https://trusted-magpie-social.ngrok.app/mcp`
4. Authentication: Bearer Token
5. Token: `<your MCP_BEARER_TOKEN>`
6. Save

### 5. Verify Installation

```bash
# Test tools/list
curl -s -X POST https://trusted-magpie-social.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test1","method":"tools/list"}' | jq .

# Test terminal.run (plan mode)
curl -s -X POST https://trusted-magpie-social.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test2","method":"tools/call","params":{"name":"terminal.run","arguments":{"bin":"echo","args":["test"],"mode":"plan"}}}' | jq .
```

## Security Features

### L4 Policies (Enforced)

**Binary Allowlist** (60+ binaries):
- Linux utilities: `bash`, `git`, `ls`, `cat`, `grep`, etc.
- Development tools: `node`, `python`, `docker`, `kubectl`, etc.
- Mind Protocol: `claude`

**Path Allowlist**:
- `/home/*` - User directories
- `/tmp`, `/var/tmp` - Temporary files
- `/opt`, `/usr/local` - Optional software
- `/workspace` - Workspace directory
- Relative paths (`./foo`)

**Shell Metacharacters** (Blocked):
- `&&`, `||`, `;`, `|`, `` ` `` - Command chaining
- All args validated before execution

### Authentication & Authorization

- **Bearer Token**: Required for all `/mcp` requests
- **Origin Check**: Only `chat.openai.com` and ngrok domain allowed
- **No New Privileges**: systemd `NoNewPrivileges=true`
- **File System**: Read-only except citizens directory

## Monitoring

### View Logs

```bash
# Real-time logs
journalctl -u mind-membrane -f

# Last 100 lines
journalctl -u mind-membrane -n 100

# Errors only
journalctl -u mind-membrane -p err
```

### Health Check

```bash
# Service status
systemctl status mind-membrane

# Test endpoint
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"health","method":"tools/list"}' | jq '.result.tools | length'
```

## Troubleshooting

### Service won't start

```bash
# Check logs for errors
journalctl -u mind-membrane -xe

# Check environment file
cat ~/.env.mcp

# Verify node binary
which node
node --version

# Check port availability
sudo lsof -i :8787
```

### SSE streaming not working

```bash
# Test progressive streaming
curl -N -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"stream-test","method":"tools/call","params":{"name":"terminal.run","arguments":{"bin":"bash","args":["-lc","printf 1; sleep 1; printf 2"],"mode":"execute","approved":true}}}'

# Should see: event:started, event:stdout (1), event:stdout (2), event:exit
```

### Policy denials

```bash
# Check audit logs
journalctl -u mind-membrane | grep denied

# Common issues:
# - Binary not in allowlist → Add to L4 BINARY_ALLOWLIST
# - Path not allowed → Add to L4 CWD_ALLOWLIST
# - Shell metacharacters → Remove from args
```

## Maintenance

### Rotate Bearer Token

```bash
# Generate new token
NEW_TOKEN=$(openssl rand -base64 32)

# Update env file
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$NEW_TOKEN/" ~/.env.mcp

# Restart service
sudo systemctl restart mind-membrane

# Update ChatGPT Connector with new token
```

### Update Server

```bash
# Pull changes
cd /home/mind-protocol/mind-membrane
git pull

# Rebuild
npm run build

# Restart service
sudo systemctl restart mind-membrane
```

### Backup

```bash
# Backup configuration
cp ~/.env.mcp ~/.env.mcp.backup

# Backup audit logs (if implemented)
cp /var/log/mind-membrane/audit.log ~/backups/
```

## Performance Tuning

### Concurrent Runs

```bash
# Limit concurrent executions (default: unlimited)
echo "MCP_MAX_CONCURRENT_RUNS=2" >> ~/.env.mcp
sudo systemctl restart mind-membrane
```

### Timeout

```bash
# Default timeout per execution (default: 20000ms)
echo "MCP_DEFAULT_TIMEOUT_MS=30000" >> ~/.env.mcp
sudo systemctl restart mind-membrane
```

### Output Limits

```bash
# Max output bytes per execution (default: unlimited)
echo "MCP_MAX_OUTPUT_BYTES=204800" >> ~/.env.mcp  # 200KB
sudo systemctl restart mind-membrane
```

## Next Steps

1. ✅ **Validated**: Linux-native execution with PTY streaming
2. ✅ **Validated**: L4 policies enforcing security boundaries
3. ✅ **Validated**: SSE streaming with anti-buffering
4. 🔜 **Implement**: `citizen.ensure` for idempotent setup
5. 🔜 **Implement**: Metrics collection (cpu_ms, bytes_out) for $MIND billing
6. 🔜 **Implement**: Audit trail verification (BLAKE3 + Ed25519)
7. 🔜 **Implement**: Resources MCP for log/artifact access

## Support

- GitHub: https://github.com/mind-protocol/mind-membrane
- Issues: https://github.com/mind-protocol/mind-membrane/issues
- Docs: https://github.com/mind-protocol/mind-membrane/tree/main/docs
