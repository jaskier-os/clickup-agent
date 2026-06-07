/**
 * Agent entry point for clickup.
 * Fetches user identity and workspaces on startup, then creates and starts the agent.
 */

import 'dotenv/config';
import { setupProxy } from '@orchestrator/sdk/proxy';
import { ClickUpClient } from './clickup-client.js';
import { ClickUpAgent } from './agent.js';

const config = {
  orchestratorUrl: process.env.ORCHESTRATOR_URL || 'ws://localhost:10001',
  communicatorUrl: process.env.COMMUNICATOR_URL || 'http://localhost:10000',
  apiKey: process.env.API_KEY || '',
  model: process.env.MODEL || 'sonnet',
  healthPort: parseInt(process.env.HEALTH_PORT || '0', 10),
  clickupApiKey: process.env.CLICKUP_API_KEY || '',
  mcpUrl: process.env.MCP_URL || 'http://localhost:10016'
};

if (!config.clickupApiKey) {
  console.error('[clickup] CLICKUP_API_KEY is required');
  process.exit(1);
}

console.log('[clickup] Starting agent');
console.log(`[clickup] Orchestrator: ${config.orchestratorUrl}`);
console.log(`[clickup] Communicator: ${config.communicatorUrl}`);
console.log(`[clickup] MCP server: ${config.mcpUrl}`);

const proxyResult = await setupProxy('clickup');

const clickup = new ClickUpClient(config.clickupApiKey, proxyResult?.dispatcher);

console.log('[clickup] Fetching user identity and workspaces...');

const user = await clickup.getUser();
console.log(`[clickup] Authenticated as: ${user.username} (id: ${user.id})`);

const workspaces = await clickup.getWorkspaces();
console.log(`[clickup] Found ${workspaces.length} workspace(s): ${workspaces.map(w => w.name).join(', ')}`);

const agent = new ClickUpAgent({
  ...config,
  clickup,
  mcpUrl: config.mcpUrl,
  userId: user.id,
  userName: user.username,
  workspaces
});

await agent.start();

console.log('[clickup] Agent started and connected to orchestrator');
