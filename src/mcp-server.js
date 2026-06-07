/**
 * ClickUp MCP Server -- Express + MCP SDK.
 * Exposes 15 ClickUp tools via HTTP /mcp endpoint.
 * Follows the web-search MCP server pattern.
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import killPort from 'kill-port';
import { ClickUpClient } from './clickup-client.js';
import { setupProxy } from '@orchestrator/sdk/proxy';

const MCP_PORT = parseInt(process.env.MCP_PORT || '10016');

const TOOLS = [
  {
    name: 'get_workspaces',
    description: 'List all workspaces the authenticated user belongs to.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_workspace_members',
    description: 'List all members (users) in a workspace. Use this to find user IDs for assigning tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' }
      },
      required: ['workspace_id']
    }
  },
  {
    name: 'list_spaces',
    description: 'List all spaces in a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' }
      },
      required: ['workspace_id']
    }
  },
  {
    name: 'list_folders',
    description: 'List all folders in a space.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID' }
      },
      required: ['space_id']
    }
  },
  {
    name: 'list_lists',
    description: 'List lists in a folder or folderless lists in a space. Provide either folder_id or space_id.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder ID (lists inside a folder)' },
        space_id: { type: 'string', description: 'Space ID (folderless lists only)' }
      }
    }
  },
  {
    name: 'list_tasks',
    description: 'Search and filter tasks in a workspace. Supports filtering by assignees, statuses, tags, dates, and sorting.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' },
        assignees: { type: 'array', items: { type: 'number' }, description: 'Filter by user IDs' },
        statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by status names (e.g. ["open", "in progress"])' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag names' },
        list_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by list IDs' },
        due_date_gt: { type: 'number', description: 'Due date after (unix ms)' },
        due_date_lt: { type: 'number', description: 'Due date before (unix ms)' },
        date_updated_gt: { type: 'number', description: 'Updated after (unix ms)' },
        date_updated_lt: { type: 'number', description: 'Updated before (unix ms)' },
        order_by: { type: 'string', enum: ['created', 'updated', 'due_date'], description: 'Sort field', default: 'updated' },
        reverse: { type: 'boolean', description: 'Sort descending', default: true },
        include_closed: { type: 'boolean', description: 'Include closed tasks', default: false },
        subtasks: { type: 'boolean', description: 'Include subtasks', default: true },
        page: { type: 'number', description: 'Page number (0-based, 100 per page)', default: 0 }
      },
      required: ['workspace_id']
    }
  },
  {
    name: 'get_task',
    description: 'Get full details of a single task including description, attachments, and custom fields.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task in a list.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'List ID to create the task in' },
        name: { type: 'string', description: 'Task name' },
        description: { type: 'string', description: 'Task description (markdown supported)' },
        status: { type: 'string', description: 'Status name (e.g. "open", "in progress")' },
        priority: { type: 'number', description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low' },
        assignees: { type: 'array', items: { type: 'number' }, description: 'User IDs to assign' },
        due_date: { type: 'number', description: 'Due date in unix ms' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to add' }
      },
      required: ['list_id', 'name']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task. Supports changing name, description, status, priority, assignees, and due date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        name: { type: 'string', description: 'New task name' },
        description: { type: 'string', description: 'New description' },
        status: { type: 'string', description: 'New status name' },
        priority: { type: 'number', description: 'New priority: 1=urgent, 2=high, 3=normal, 4=low' },
        assignees: {
          type: 'object',
          description: 'Assignee changes',
          properties: {
            add: { type: 'array', items: { type: 'number' }, description: 'User IDs to add' },
            rem: { type: 'array', items: { type: 'number' }, description: 'User IDs to remove' }
          }
        },
        due_date: { type: 'number', description: 'New due date in unix ms' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_comments',
    description: 'Get comments on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'create_comment',
    description: 'Post a comment on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        comment_text: { type: 'string', description: 'Comment text' }
      },
      required: ['task_id', 'comment_text']
    }
  },
  {
    name: 'list_tags',
    description: 'List all tags in a space.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID' }
      },
      required: ['space_id']
    }
  },
  {
    name: 'add_tag_to_task',
    description: 'Add a tag to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        tag_name: { type: 'string', description: 'Tag name' }
      },
      required: ['task_id', 'tag_name']
    }
  },
  {
    name: 'remove_tag_from_task',
    description: 'Remove a tag from a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        tag_name: { type: 'string', description: 'Tag name' }
      },
      required: ['task_id', 'tag_name']
    }
  }
];

class ClickUpMCPServer {
  constructor(clickupClient) {
    this.clickup = clickupClient;
    this.server = new Server(
      { name: 'mcp-clickup', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        console.log(`[mcp-clickup] Tool call: ${name}`);
        const result = await this.executeTool(name, args || {});
        return {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        console.error(`[mcp-clickup] Tool error: ${name} -- ${error.message}`);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    });
  }

  async executeTool(name, args) {
    switch (name) {
      case 'get_workspaces': {
        const workspaces = await this.clickup.getWorkspaces();
        return workspaces.map(w => ({ id: w.id, name: w.name, members: w.members?.length }));
      }

      case 'get_workspace_members': {
        const data = await this.clickup.getWorkspaceMembers(args.workspace_id);
        return (data.members || []).map(m => ({
          id: m.user?.id,
          username: m.user?.username,
          email: m.user?.email,
          role: m.role?.name || m.role
        }));
      }

      case 'list_spaces': {
        const data = await this.clickup.listSpaces(args.workspace_id);
        return (data.spaces || []).map(s => ({
          id: s.id,
          name: s.name,
          private: s.private,
          statuses: s.statuses?.map(st => st.status) || []
        }));
      }

      case 'list_folders': {
        const data = await this.clickup.listFolders(args.space_id);
        return (data.folders || []).map(f => ({
          id: f.id,
          name: f.name,
          list_count: f.lists?.length || 0
        }));
      }

      case 'list_lists': {
        let data;
        if (args.folder_id) {
          data = await this.clickup.listLists(args.folder_id);
        } else if (args.space_id) {
          data = await this.clickup.getFolderlessLists(args.space_id);
        } else {
          throw new Error('Provide either folder_id or space_id');
        }
        return (data.lists || []).map(l => ({
          id: l.id,
          name: l.name,
          task_count: l.task_count,
          status: l.status?.status,
          folder: l.folder?.name
        }));
      }

      case 'list_tasks': {
        const data = await this.clickup.getFilteredTasks(args.workspace_id, {
          assignees: args.assignees,
          statuses: args.statuses,
          tags: args.tags,
          list_ids: args.list_ids,
          due_date_gt: args.due_date_gt,
          due_date_lt: args.due_date_lt,
          date_updated_gt: args.date_updated_gt,
          date_updated_lt: args.date_updated_lt,
          orderBy: args.order_by || 'updated',
          reverse: args.reverse !== undefined ? args.reverse : true,
          includeClosed: args.include_closed || false,
          subtasks: args.subtasks !== undefined ? args.subtasks : true,
          page: args.page || 0
        });
        return (data.tasks || []).map(t => ({
          id: t.id,
          name: t.name,
          status: t.status?.status || t.status,
          priority: t.priority?.priority || t.priority,
          due_date: t.due_date ? new Date(parseInt(t.due_date)).toISOString() : null,
          date_updated: t.date_updated ? new Date(parseInt(t.date_updated)).toISOString() : null,
          list: t.list?.name,
          folder: t.folder?.name,
          space: t.space?.name,
          tags: t.tags?.map(tag => tag.name) || [],
          assignees: t.assignees?.map(a => ({ id: a.id, username: a.username })) || [],
          url: t.url
        }));
      }

      case 'get_task': {
        const task = await this.clickup.getTask(args.task_id);
        return {
          id: task.id,
          name: task.name,
          status: task.status?.status || task.status,
          priority: task.priority?.priority || task.priority,
          due_date: task.due_date ? new Date(parseInt(task.due_date)).toISOString() : null,
          date_updated: task.date_updated ? new Date(parseInt(task.date_updated)).toISOString() : null,
          date_created: task.date_created ? new Date(parseInt(task.date_created)).toISOString() : null,
          list: task.list?.name,
          folder: task.folder?.name,
          space: task.space?.name,
          tags: task.tags?.map(tag => tag.name) || [],
          assignees: task.assignees?.map(a => ({ id: a.id, username: a.username })) || [],
          description: task.description || task.text_content || '(no description)',
          markdown_description: task.markdown_description || null,
          url: task.url,
          attachments: (task.attachments || []).map(a => ({
            id: a.id,
            title: a.title || a.name,
            url: a.url,
            type: a.extension || a.type,
            size: a.size
          })),
          custom_fields: (task.custom_fields || [])
            .filter(f => f.value !== undefined && f.value !== null)
            .map(f => ({ name: f.name, value: f.value }))
        };
      }

      case 'create_task': {
        const taskData = { name: args.name };
        if (args.description) taskData.description = args.description;
        if (args.status) taskData.status = args.status;
        if (args.priority) taskData.priority = args.priority;
        if (args.assignees) taskData.assignees = args.assignees;
        if (args.due_date) taskData.due_date = args.due_date;
        if (args.tags) taskData.tags = args.tags;

        const task = await this.clickup.createTask(args.list_id, taskData);
        return { id: task.id, name: task.name, status: task.status?.status, url: task.url };
      }

      case 'update_task': {
        const updates = {};
        if (args.name) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.status) updates.status = args.status;
        if (args.priority) updates.priority = args.priority;
        if (args.assignees) updates.assignees = args.assignees;
        if (args.due_date) updates.due_date = args.due_date;

        const result = await this.clickup.updateTask(args.task_id, updates);
        return { id: result.id, name: result.name, status: result.status?.status || 'unknown', url: result.url };
      }

      case 'delete_task': {
        await this.clickup.deleteTask(args.task_id);
        return { deleted: true, task_id: args.task_id };
      }

      case 'get_comments': {
        const data = await this.clickup.getComments(args.task_id);
        return (data.comments || []).map(c => ({
          id: c.id,
          author: c.user?.username || 'unknown',
          text: c.comment_text,
          date: c.date ? new Date(parseInt(c.date)).toISOString() : null,
          reply_count: c.reply_count || 0,
          reactions: c.reactions?.map(r => `${r.reaction} by ${r.user?.username || 'unknown'}`) || []
        }));
      }

      case 'create_comment': {
        await this.clickup.postComment(args.task_id, args.comment_text);
        return { posted: true, task_id: args.task_id };
      }

      case 'list_tags': {
        const data = await this.clickup.listSpaceTags(args.space_id);
        return (data.tags || []).map(t => ({ name: t.name, fg_color: t.tag_fg, bg_color: t.tag_bg }));
      }

      case 'add_tag_to_task': {
        await this.clickup.addTagToTask(args.task_id, args.tag_name);
        return { added: true, task_id: args.task_id, tag: args.tag_name };
      }

      case 'remove_tag_from_task': {
        await this.clickup.removeTagFromTask(args.task_id, args.tag_name);
        return { removed: true, task_id: args.task_id, tag: args.tag_name };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[mcp-clickup] Server error:', error.message);
    };

    process.on('SIGINT', async () => {
      console.log('[mcp-clickup] Shutting down...');
      try { await this.server.close(); } catch {}
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('[mcp-clickup] Shutting down...');
      try { await this.server.close(); } catch {}
      process.exit(0);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[mcp-clickup] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
    });
  }

  async run() {
    try {
      await killPort(MCP_PORT).catch(() => {});
    } catch {}

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));

    app.get('/health', (req, res) => {
      res.json({ status: 'ok', version: '1.0.0', service: 'mcp-clickup', tools: TOOLS.length });
    });

    app.post('/mcp', async (req, res) => {
      try {
        const { method, params } = req.body;

        if (method === 'tools/call') {
          const { name, arguments: args } = params;
          const result = await this.executeTool(name, args || {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          res.json({ result: { content: [{ type: 'text', text }] } });
        } else if (method === 'tools/list') {
          res.json({ result: { tools: TOOLS } });
        } else {
          res.status(400).json({ error: `Unsupported method: ${method}` });
        }
      } catch (error) {
        console.error(`[mcp-clickup] HTTP error: ${error.message}`);
        res.json({ result: { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true } });
      }
    });

    app.use((err, req, res, next) => {
      console.error('[mcp-clickup] Express error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    });

    const server = app.listen(MCP_PORT, () => {
      console.log(`[mcp-clickup] MCP ClickUp Server running on http://localhost:${MCP_PORT} (${TOOLS.length} tools)`);
    });

    server.on('error', (error) => {
      console.error('[mcp-clickup] HTTP server error:', error.message);
      process.exit(1);
    });
  }
}

// --- Main ---

const apiKey = process.env.CLICKUP_API_KEY;
if (!apiKey) {
  console.error('[mcp-clickup] CLICKUP_API_KEY is required');
  process.exit(1);
}

const proxyResult = await setupProxy('mcp-clickup');
const client = new ClickUpClient(apiKey, proxyResult?.dispatcher);

console.log('[mcp-clickup] Verifying API key...');
try {
  const user = await client.getUser();
  console.log(`[mcp-clickup] Authenticated as: ${user.username} (id: ${user.id})`);
} catch (err) {
  console.error(`[mcp-clickup] Auth failed: ${err.message}`);
  process.exit(1);
}

const mcpServer = new ClickUpMCPServer(client);
await mcpServer.run();
