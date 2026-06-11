# clickup-agent

> **Docs & wiki:** [github.com/jaskier-os/docs/wiki](https://github.com/jaskier-os/docs/wiki)

ClickUp integration for the orchestrator, in two parts. The MCP server
(`src/mcp-server.js`) exposes ClickUp operations -- workspaces, spaces, folders, lists,
tasks, comments, filtering, search -- as MCP tools over HTTP. The agent
(`src/agent-entry.js`) connects to the orchestrator over WebSocket and drives those tools
via an LLM (through the communicator gateway). They run together or independently.

## Build / run

```bash
npm install

npm run mcp      # MCP server only (standalone, no orchestrator)
npm run agent    # agent only (needs orchestrator + communicator)
./run.sh both    # both, with supervision

npm run dev      # agent, auto-reload
npm run dev:mcp  # MCP server, auto-reload
npm test         # integration test against the live ClickUp API (needs MCP running + token)
```

Docker:

```bash
docker build -f Dockerfile.agent -t clickup-agent .
docker run --env-file .env clickup-agent
```

## Configuration

Config is env vars; `.env.example` is the source of truth. Copy it to `.env` and edit.
The only required value is `CLICKUP_API_KEY` (a ClickUp personal token, `pk_...`). Other
key vars:

- `MCP_PORT` / `MCP_URL` -- MCP server listen port and the URL the agent reaches it on
- `ORCHESTRATOR_URL` -- orchestrator WebSocket URL (`wss://` for TLS)
- `COMMUNICATOR_URL`, `API_KEY`, `MODEL`, `HEALTH_PORT`
- optional: `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`

## Dependencies

Node 20+ (ES modules). No model weights -- calls the hosted ClickUp API and an external
LLM gateway. `@orchestrator/sdk` is vendored in `./vendor/orchestrator-sdk`
(`file:./vendor/orchestrator-sdk`): a point-in-time copy of the SDK from the
`jaskier-os/orchestrator` repo, not a published package.
