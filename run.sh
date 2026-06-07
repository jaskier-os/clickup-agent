#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

MODE="${1:-both}"

echo "[clickup] Installing dependencies..."
npm install --silent

case "$MODE" in
  mcp)
    echo "[clickup] Starting MCP server on port ${MCP_PORT:-10016}..."
    exec node src/mcp-server.js
    ;;
  agent)
    echo "[clickup] Starting agent (connects to orchestrator)..."
    exec node src/agent-entry.js
    ;;
  both|*)
    set +e
    echo "[clickup] Starting MCP server + agent..."
    MCP_PID=0
    AGENT_PID=0

    cleanup() { kill $MCP_PID $AGENT_PID 2>/dev/null; exit 0; }
    trap cleanup SIGTERM SIGINT EXIT

    start_mcp() {
      node src/mcp-server.js &
      MCP_PID=$!
      echo "[clickup] MCP server started (PID $MCP_PID)"
    }

    start_agent() {
      node src/agent-entry.js &
      AGENT_PID=$!
      echo "[clickup] Agent started (PID $AGENT_PID)"
    }

    start_mcp
    sleep 2
    start_agent

    while true; do
      wait -n 2>/dev/null || sleep 1
      if ! kill -0 $MCP_PID 2>/dev/null; then
        echo "[clickup] MCP server died, restarting in 2s..."
        sleep 2
        start_mcp
      fi
      if ! kill -0 $AGENT_PID 2>/dev/null; then
        echo "[clickup] Agent died, restarting in 2s..."
        sleep 2
        start_agent
      fi
    done
    ;;
esac
