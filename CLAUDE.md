# CLAUDE.md -- ClickUp Agent

Guidance for Claude Code working in this standalone repo.

IMPORTANT: NEVER USE EMOJIS ANYWHERE IN LOGGING, CODE OR OTHER TEXT!

IMPORTANT: Treat this codebase as work in progress. Never do backwards-compatibility or legacy support unless explicitly asked. Remove code that becomes redundant.

## What this service is

ClickUp project-management integration. Two components in one codebase:
- an MCP server (default port 10016) exposing ClickUp tools, and
- an agentic wrapper that connects OUTBOUND to the orchestrator over a WebSocket, receives requests, asks the LLM (via Communicator) which tool to call, and calls the MCP server.

Tools include `get_workspaces`, `get_workspace_members`, `list_folders`, `create_task`, `get_task`, `delete_task`, `add_tag_to_task`, `create_comment`, `get_comments`, `ask_user_confirmation`.

Health endpoint on port 10012. Requires `CLICKUP_API_KEY`.

This is one specialized agent in a larger orchestration system: devices (glasses/phone/PC) -> Orchestrator (intent classification + routing) -> specialized agents over WebSocket -> Communicator (LLM gateway). For the big picture, the full port map, and the protocol spec, see the orchestrator repo (`jaskier-os/orchestrator`, its `CLAUDE.md` / `docs/`). Do not duplicate that map here.

## Vendored SDK

`@orchestrator/sdk` lives in `./vendor/orchestrator-sdk` (referenced as `file:./vendor/orchestrator-sdk` in `package.json`). It is a POINT-IN-TIME COPY whose source of truth is `jaskier-os/orchestrator` (`sdk/`). Treat it as read-only; do not hand-edit it to fix agent behavior. If the SDK genuinely needs a change, change it in the orchestrator repo and re-vendor.

The SDK provides `BaseAgent` (WS auto-reconnect, manifest registration, graceful shutdown), the message-envelope protocol, and `AGENT_RESPONSE_STATUS` constants.

## Agent interface contract

The agent extends `BaseAgent` and implements `handle(request)` returning `{ requestId, status, text }`.

**Response statuses:** `success` / `error` / `partial` (final), `needs_input` (needs device input, e.g. user confirmation), `needs_agent` (delegate to another agent).

Adding a tool requires no orchestrator changes -- the classifier discovers registered agents from their manifests.

## Key files

```
src/
  agent-entry.js    -- Agent entrypoint (starts MCP server, connects agent to orchestrator)
  agent.js          -- ClickUpAgent (agentic loop)
  mcp-server.js     -- MCP tool server
  clickup-client.js -- ClickUp API client
vendor/orchestrator-sdk/  -- vendored @orchestrator/sdk (source: jaskier-os/orchestrator)
tests/              -- MCP integration tests
run.sh              -- Startup script
```

## Common commands

```bash
npm run agent             # node src/agent-entry.js
npm run mcp               # node src/mcp-server.js
npm run dev               # nodemon src/agent-entry.js
npm run dev:mcp           # nodemon src/mcp-server.js
npm test                  # node --test tests/mcp-integration.test.js
./run.sh                  # production startup
```

## Environment variables

See `.env.example`:
- `CLICKUP_API_KEY` -- required, ClickUp API token
- `MCP_PORT` / `MCP_URL` -- MCP server (default 10016)
- `ORCHESTRATOR_URL` -- WebSocket URL for orchestrator
- `COMMUNICATOR_URL` -- LLM API gateway URL
- `API_KEY` -- API key for communicator
- `MODEL` -- LLM model (default sonnet)
- `HEALTH_PORT` -- health endpoint port (10012)

## Build & deployment

`.gitlab-ci.yml` builds this repo's `Dockerfile.agent` with `docker buildx --push` on push to main, then the deploy stage bumps the image tag in the `infrastructure/deploy` repo and Flux reconciles it onto the cluster.

**Server-side auto-deploy:** services deploy automatically on git push to main. No manual restart needed -- just commit and push.

NEVER restart a deployed service or modify Kubernetes directly (`kubectl set env/edit/patch`). All changes to deployed services go through the `infrastructure/deploy` manifests via CI -> Flux. Direct changes get overwritten and cause drift.
