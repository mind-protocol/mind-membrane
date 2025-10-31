#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env file
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "Starting Mind Membrane MCP Server..."
echo "  Port: ${MCP_PORT:-8787}"
echo "  Allowed Origins: ${MCP_ALLOWED_ORIGINS:-none}"
echo "  Bearer Token: ${MCP_BEARER_TOKEN:+configured}"
echo ""

cd apps/server
node dist/index.js
