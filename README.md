# ClickUp Agent

A ClickUp integration consisting of two parts:

- An **MCP server** that exposes ClickUp operations (workspaces, spaces, folders,
  lists, tasks, comments, filtering, search) as Model Context Protocol tools over HTTP.
- An **agent** that connects to an orchestrator over WebSocket, receives natural-language
  requests, and uses the MCP tools (driven by an LLM via a communicator gateway) to manage
  ClickUp tasks and navigate a workspace.

The two can run together or independently.

## Prerequisites

- Node.js 20+ (ES modules)
- A ClickUp personal API token (`pk_...`)
- Optional, for the agent half: a running orchestrator (WebSocket) and communicator
  (LLM gateway). The MCP server runs standalone without either.

## Setup

```bash
cp .env.example .env
# edit .env and fill in at least CLICKUP_API_KEY
npm install
```

Every variable is documented inline in `.env.example`. The only required value is
`CLICKUP_API_KEY`.

The bundled `@orchestrator/sdk` (shared agent base classes, protocol, proxy/TLS helpers)
is vendored under `vendor/orchestrator-sdk/` and wired up via a local file dependency, so a
fresh clone installs with no access to any private registry or monorepo.

## Build

No build step is required (plain Node.js ES modules). `npm install` is the only step.

## Run

```bash
# MCP server only (standalone, no orchestrator needed):
npm run mcp

# Agent only (requires orchestrator + communicator reachable):
npm run agent

# Both, with auto-restart supervision:
./run.sh both
```

Dev variants with auto-reload: `npm run dev` (agent) and `npm run dev:mcp` (MCP server).

## Test

```bash
# Requires the MCP server running (npm run mcp) and a valid CLICKUP_API_KEY.
npm test
```

The integration test exercises the live MCP server against the ClickUp API, so it needs
network access and a real token.

## TLS / proxy (optional)

The agent talks plain WebSocket by default. TLS and proxies are entirely optional:

- **TLS to the orchestrator:** set `ORCHESTRATOR_URL` to a `wss://` URL. To trust a private
  CA, set `NODE_EXTRA_CA_CERTS` to the PEM path. If that variable is unset or the file is
  missing, the agent still connects (it just does not add a custom CA). No cert is required
  to run, and no cert/key files are shipped with this repo.
- **Outbound proxy:** set `HTTPS_PROXY` / `HTTP_PROXY` (and optionally `NO_PROXY`) to route
  ClickUp and communicator traffic through a proxy. Unset means a direct connection.

## Configuration reference

See `.env.example` for the full list of environment variables and what each does.

## Model weights

None. This project calls the hosted ClickUp API and an external LLM gateway; it ships no
model weights or large binaries.
