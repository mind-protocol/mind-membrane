# Mind Membrane MCP Server - Operations Runbook

## Emergency Procedures

### Service Down

```bash
# Check service status
sudo systemctl status mind-membrane

# View recent logs
journalctl -u mind-membrane -n 50 --no-pager

# Restart service
sudo systemctl restart mind-membrane

# Verify restart
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer $(grep MCP_BEARER_TOKEN ~/.env.mcp | cut -d= -f2)" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"health","method":"tools/list"}' | jq -r '.result.tools | length'
```

### High CPU Usage

```bash
# Check running PTY processes
ps aux | grep node-pty

# Check for hung processes
ps aux | grep bash | grep -v grep

# Kill specific PTY if needed
kill -9 <PID>

# Restart service to clean up
sudo systemctl restart mind-membrane
```

### Port Already in Use

```bash
# Find process using port 8787
sudo lsof -i :8787

# Kill the process
sudo kill -9 <PID>

# Start service
sudo systemctl start mind-membrane
```

### Memory Leak

```bash
# Check memory usage
ps aux | grep "node dist/index.js"

# Restart service (temp fix)
sudo systemctl restart mind-membrane

# Enable memory limits in systemd (permanent fix)
sudo systemctl edit mind-membrane

# Add:
# [Service]
# MemoryMax=512M
# MemoryHigh=400M
```

## Routine Maintenance

### Daily Checks

```bash
#!/bin/bash
# scripts/daily-check.sh

# Service status
systemctl is-active mind-membrane || echo "⚠️  Service not running"

# Recent errors
ERROR_COUNT=$(journalctl -u mind-membrane --since "24 hours ago" -p err --no-pager | wc -l)
echo "Errors (24h): $ERROR_COUNT"

# Denied requests (security)
DENIED_COUNT=$(journalctl -u mind-membrane --since "24 hours ago" | grep -c "denied")
echo "Policy denials (24h): $DENIED_COUNT"

# Disk space
df -h /home/mind-protocol | tail -1
```

### Weekly Tasks

- Review audit logs for anomalies
- Check for Mind Membrane updates (`git pull`)
- Verify ngrok tunnel is stable
- Review Bearer token rotation schedule

### Monthly Tasks

- **Rotate Bearer Token** (security best practice)
- Review and update L4 policies if needed
- Archive old logs
- Review citizen directories for cleanup

## Token Rotation

### Manual Rotation

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -base64 32)
echo "New token: $NEW_TOKEN"

# 2. Update env file
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$NEW_TOKEN/" ~/.env.mcp

# 3. Restart service
sudo systemctl restart mind-membrane

# 4. Test with new token
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test","method":"tools/list"}' | jq .

# 5. Update ChatGPT Connector
echo "⚠️  Update Bearer token in ChatGPT Settings → Connectors"
```

### Automated Rotation (Future)

```bash
# scripts/rotate-token.sh
#!/bin/bash
set -euo pipefail

NEW_TOKEN=$(openssl rand -base64 32)
OLD_TOKEN=$(grep MCP_BEARER_TOKEN ~/.env.mcp | cut -d= -f2)

# Update env
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$NEW_TOKEN/" ~/.env.mcp

# Restart service
sudo systemctl restart mind-membrane

# Log rotation
logger -t mind-membrane "Bearer token rotated"

echo "New token: $NEW_TOKEN"
echo "⚠️  Update ChatGPT Connector within 5 minutes"
```

## Backup & Recovery

### Configuration Backup

```bash
# Backup env file
cp ~/.env.mcp ~/backups/env.mcp.$(date +%Y%m%d)

# Backup systemd service
sudo cp /etc/systemd/system/mind-membrane.service ~/backups/

# Backup L4 policies (if customized)
cp /home/mind-protocol/mind-membrane/packages/l4/src/index.ts ~/backups/l4-policies.$(date +%Y%m%d).ts
```

### Recovery

```bash
# Restore env file
cp ~/backups/env.mcp.YYYYMMDD ~/.env.mcp

# Restore service file
sudo cp ~/backups/mind-membrane.service /etc/systemd/system/
sudo systemctl daemon-reload

# Restart
sudo systemctl restart mind-membrane
```

## Monitoring & Alerting

### Key Metrics to Track

1. **Service Uptime**: `systemctl is-active mind-membrane`
2. **Request Rate**: Count of `tools/call` in logs
3. **Error Rate**: Count of `denied` + `error` events
4. **Response Time**: Time from `started` to `exit` event
5. **Memory Usage**: `ps aux | grep node`

### Simple Alert Script

```bash
#!/bin/bash
# scripts/alert-check.sh

# Check if service is running
if ! systemctl is-active --quiet mind-membrane; then
  echo "🚨 ALERT: Mind Membrane service is DOWN"
  # Send alert (email, webhook, etc.)
  exit 1
fi

# Check error rate (last hour)
ERROR_COUNT=$(journalctl -u mind-membrane --since "1 hour ago" -p err --no-pager | wc -l)
if [ "$ERROR_COUNT" -gt 10 ]; then
  echo "⚠️  WARNING: High error rate ($ERROR_COUNT errors in last hour)"
fi

# Check denied requests (potential attack)
DENIED_COUNT=$(journalctl -u mind-membrane --since "1 hour ago" | grep -c "denied" || true)
if [ "$DENIED_COUNT" -gt 50 ]; then
  echo "🔒 SECURITY: High denial rate ($DENIED_COUNT denials in last hour)"
fi

echo "✅ All checks passed"
```

## Degraded Mode

If PTY/streaming fails, temporary fallback to basic execution:

```typescript
// Fallback: Use child_process.spawn for non-interactive commands
import { spawn } from "child_process";

const proc = spawn(bin, args, { cwd, env });
proc.stdout.on("data", chunk => sse.send("stdout", { chunk: chunk.toString() }));
proc.stderr.on("data", chunk => sse.send("stderr", { chunk: chunk.toString() }));
proc.on("close", code => {
  sse.send("exit", { code });
  res.end();
});
```

## Performance Tuning

### Concurrent Execution Limits

```bash
# Limit to 2 simultaneous executions
echo "MCP_MAX_CONCURRENT_RUNS=2" >> ~/.env.mcp
sudo systemctl restart mind-membrane
```

### Timeout Configuration

```bash
# Increase default timeout to 60s
echo "MCP_DEFAULT_TIMEOUT_MS=60000" >> ~/.env.mcp
sudo systemctl restart mind-membrane
```

### Output Size Limits

```bash
# Limit output to 1MB per execution
echo "MCP_MAX_OUTPUT_BYTES=1048576" >> ~/.env.mcp
sudo systemctl restart mind-membrane
```

## Security Incidents

### Suspicious Activity Detected

```bash
# Check denied requests
journalctl -u mind-membrane | grep "denied" | tail -50

# Check origin violations
journalctl -u mind-membrane | grep "Origin not allowed"

# Check unauthorized attempts
journalctl -u mind-membrane | grep "Unauthorized"

# If under attack:
# 1. Rotate Bearer token immediately
# 2. Review and tighten MCP_ALLOWED_ORIGINS
# 3. Consider rate limiting at ngrok level
```

### Compromise Response

```bash
# 1. Stop service immediately
sudo systemctl stop mind-membrane

# 2. Rotate all credentials
NEW_TOKEN=$(openssl rand -base64 32)
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$NEW_TOKEN/" ~/.env.mcp

# 3. Review logs for IOCs
journalctl -u mind-membrane --since "7 days ago" > /tmp/incident-logs.txt

# 4. Inspect running processes
ps aux | grep -E "(bash|node)" > /tmp/processes.txt

# 5. Check for suspicious files
find /home/mind-protocol/mindprotocol -type f -mtime -7

# 6. Restart with new token
sudo systemctl start mind-membrane

# 7. Monitor closely
journalctl -u mind-membrane -f
```

## Escalation

### When to Escalate

- Service down > 5 minutes
- Error rate > 100/hour
- Suspected security breach
- Memory leak causing OOM
- Unknown binaries in execution logs

### Escalation Contacts

- **Primary**: DevOps Team
- **Security**: Security Team
- **Development**: Mind Protocol Team

## Testing After Changes

```bash
# Run smoke tests
./scripts/smoke-linux.sh

# Test progressive streaming
curl -N -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $(grep MCP_BEARER_TOKEN ~/.env.mcp | cut -d= -f2)" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"smoke","method":"tools/call","params":{"name":"terminal.run","arguments":{"bin":"bash","args":["-lc","printf test"],"mode":"execute","approved":true}}}'

# Verify all tools listed
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer $(grep MCP_BEARER_TOKEN ~/.env.mcp | cut -d= -f2)" \
  -H "Origin: https://chat.openai.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"list","method":"tools/list"}' | jq '.result.tools | length'
```

## Change Log

- **2025-10-31**: Initial runbook created
- **2025-10-31**: Added PTY streaming procedures
- **2025-10-31**: Added L4 policy documentation

## References

- Deployment Guide: `docs/deployment.md`
- Architecture: `README.md`
- L4 Policies: `packages/l4/src/index.ts`
- Systemd Service: `infra/systemd/mind-membrane.service`
