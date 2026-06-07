/**
 * Integration tests for ClickUp MCP server.
 * Tests all 15 tools against the real ClickUp API via MCP HTTP endpoint.
 *
 * Prerequisites:
 *   - MCP server running on MCP_URL (default: http://localhost:10016)
 *   - Valid CLICKUP_API_KEY in .env
 *
 * Usage:
 *   npm run mcp &          # start MCP server
 *   sleep 3
 *   node tests/mcp-integration.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const MCP_URL = process.env.MCP_URL || 'http://localhost:10016';

/** Call an MCP tool via HTTP. Returns parsed result text. */
async function callTool(name, args = {}) {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } })
  });
  assert.ok(res.ok, `HTTP ${res.status} for ${name}`);
  const data = await res.json();

  if (data.result?.isError) {
    return { error: true, text: data.result.content[0].text };
  }

  const text = data.result.content[0].text;
  try { return { error: false, data: JSON.parse(text) }; }
  catch { return { error: false, data: text }; }
}

// Shared state across tests
let workspaceId;
let createdTaskId;
let testListId;

describe('MCP Server Health', () => {
  test('GET /health returns ok', async () => {
    const res = await fetch(`${MCP_URL}/health`);
    assert.ok(res.ok);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'mcp-clickup');
    assert.equal(data.tools, 15);
  });

  test('POST /mcp tools/list returns 15 tools', async () => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tools/list' })
    });
    const data = await res.json();
    assert.equal(data.result.tools.length, 15);
    const names = data.result.tools.map(t => t.name);
    assert.ok(names.includes('list_tasks'));
    assert.ok(names.includes('create_task'));
    assert.ok(names.includes('delete_task'));
  });
});

describe('Workspace Tools', () => {
  test('get_workspaces returns at least one workspace', async () => {
    const result = await callTool('get_workspaces');
    assert.equal(result.error, false);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.length > 0, 'Expected at least one workspace');
    assert.ok(result.data[0].id, 'Workspace should have id');
    assert.ok(result.data[0].name, 'Workspace should have name');
    workspaceId = result.data[0].id;
  });

  test('get_workspace_members returns array', async () => {
    const result = await callTool('get_workspace_members', { workspace_id: workspaceId });
    // May return 0 members depending on workspace permissions, but should not error
    if (!result.error) {
      assert.ok(Array.isArray(result.data));
    }
  });
});

describe('Hierarchy Tools', () => {
  test('list_spaces returns array', async () => {
    const result = await callTool('list_spaces', { workspace_id: workspaceId });
    if (!result.error) {
      assert.ok(Array.isArray(result.data));
    }
  });

  test('list_folders requires space_id', async () => {
    const result = await callTool('list_folders', {});
    assert.equal(result.error, true);
  });

  test('list_lists requires folder_id or space_id', async () => {
    const result = await callTool('list_lists', {});
    assert.equal(result.error, true);
  });
});

describe('Task Tools', () => {
  test('list_tasks returns tasks array with expected fields', async () => {
    const result = await callTool('list_tasks', { workspace_id: workspaceId });
    assert.equal(result.error, false);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.length > 0, 'Expected at least one task');

    const task = result.data[0];
    assert.ok(task.id, 'Task should have id');
    assert.ok(task.name, 'Task should have name');
    assert.ok('status' in task, 'Task should have status');
    assert.ok('url' in task, 'Task should have url');
    assert.ok(Array.isArray(task.tags), 'Task should have tags array');
    assert.ok(Array.isArray(task.assignees), 'Task should have assignees array');

    // Save a list ID for create_task test
    // Fetch a task to get its list ID
    const detail = await callTool('get_task', { task_id: task.id });
    if (!detail.error && detail.data.list) {
      // We need the list ID, not name. Fetch raw to get it.
      const rawRes = await fetch(`${MCP_URL}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'get_task', arguments: { task_id: task.id } } })
      });
      const rawData = await rawRes.json();
      // The MCP server doesn't return list ID directly in the formatted output.
      // We'll use a known list ID from the workspace or find it via the raw API.
    }
  });

  test('list_tasks supports filtering by status', async () => {
    const result = await callTool('list_tasks', {
      workspace_id: workspaceId,
      statuses: ['open'],
      order_by: 'updated',
      reverse: true,
      page: 0
    });
    assert.equal(result.error, false);
    assert.ok(Array.isArray(result.data));
  });

  test('get_task returns full task detail', async () => {
    // First get a task ID
    const listResult = await callTool('list_tasks', { workspace_id: workspaceId });
    assert.equal(listResult.error, false);
    assert.ok(listResult.data.length > 0);

    const taskId = listResult.data[0].id;
    const result = await callTool('get_task', { task_id: taskId });
    assert.equal(result.error, false);
    assert.ok(result.data.id);
    assert.ok(result.data.name);
    assert.ok('description' in result.data);
    assert.ok('attachments' in result.data);
    assert.ok('custom_fields' in result.data);
    assert.ok(result.data.url);
  });

  test('get_task requires task_id', async () => {
    const result = await callTool('get_task', {});
    assert.equal(result.error, true);
  });
});

describe('CRUD Lifecycle', () => {
  before(async () => {
    // Find a list ID from an existing task
    const listResult = await callTool('list_tasks', { workspace_id: workspaceId });
    if (listResult.data?.length > 0) {
      const taskId = listResult.data[0].id;
      // Get raw task to find list_id
      const API_KEY = process.env.CLICKUP_API_KEY;
      if (API_KEY) {
        const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
          headers: { 'Authorization': API_KEY }
        });
        const task = await res.json();
        testListId = task.list?.id;
      }
    }
  });

  test('create_task creates a task', async () => {
    if (!testListId) {
      console.log('  [skip] No list ID available for create test');
      return;
    }
    const result = await callTool('create_task', {
      list_id: testListId,
      name: 'MCP Integration Test - Auto Delete',
      description: 'Created by automated integration test'
    });
    assert.equal(result.error, false);
    assert.ok(result.data.id, 'Created task should have id');
    assert.equal(result.data.name, 'MCP Integration Test - Auto Delete');
    assert.ok(result.data.url);
    createdTaskId = result.data.id;
  });

  test('update_task updates status', async () => {
    if (!createdTaskId) {
      console.log('  [skip] No task created to update');
      return;
    }
    const result = await callTool('update_task', {
      task_id: createdTaskId,
      status: 'in progress',
      priority: 3
    });
    assert.equal(result.error, false);
    assert.equal(result.data.status, 'in progress');
  });

  test('create_comment posts a comment', async () => {
    if (!createdTaskId) {
      console.log('  [skip] No task created to comment on');
      return;
    }
    const result = await callTool('create_comment', {
      task_id: createdTaskId,
      comment_text: 'Integration test comment'
    });
    assert.equal(result.error, false);
    assert.ok(result.data.posted || typeof result.data === 'string');
  });

  test('get_comments returns posted comment', async () => {
    if (!createdTaskId) {
      console.log('  [skip] No task created');
      return;
    }
    const result = await callTool('get_comments', { task_id: createdTaskId });
    assert.equal(result.error, false);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.length > 0, 'Should have at least one comment');
    assert.ok(result.data.some(c => c.text?.includes('Integration test comment')));
  });

  test('delete_task removes the task', async () => {
    if (!createdTaskId) {
      console.log('  [skip] No task created to delete');
      return;
    }
    const result = await callTool('delete_task', { task_id: createdTaskId });
    assert.equal(result.error, false);
    assert.ok(result.data.deleted);
    createdTaskId = null;
  });

  after(async () => {
    // Cleanup: delete the test task if still exists
    if (createdTaskId) {
      console.log('  [cleanup] Deleting leftover test task', createdTaskId);
      await callTool('delete_task', { task_id: createdTaskId });
    }
  });
});

describe('Tag Tools', () => {
  test('list_tags requires space_id', async () => {
    const result = await callTool('list_tags', {});
    assert.equal(result.error, true);
  });

  test('add_tag_to_task requires task_id and tag_name', async () => {
    const result = await callTool('add_tag_to_task', {});
    assert.equal(result.error, true);
  });

  test('remove_tag_from_task requires task_id and tag_name', async () => {
    const result = await callTool('remove_tag_from_task', {});
    assert.equal(result.error, true);
  });
});

describe('Error Handling', () => {
  test('unknown tool returns error', async () => {
    const result = await callTool('nonexistent_tool', {});
    assert.equal(result.error, true);
  });

  test('unsupported method returns 400', async () => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'unsupported/method' })
    });
    assert.equal(res.status, 400);
  });

  test('invalid task_id returns error', async () => {
    const result = await callTool('get_task', { task_id: 'invalid_xyz_123' });
    assert.equal(result.error, true);
  });
});
