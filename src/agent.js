/**
 * ClickUp Agent -- manages ClickUp tasks via PTC (Programmatic Tool Calling).
 *
 * Tools: 15 ClickUp tools (via MCP server with direct API fallback) + 3 local meta-tools.
 * Delegation: delegates to pc-agent for task execution via DelegationError.
 * Clarification: uses DeviceInputError for user confirmation before destructive actions.
 */

import { BaseAgent, PTCClient, DelegationError, DeviceInputError } from '@orchestrator/sdk';

/**
 * Format a ClickUp task for concise display.
 */
function formatTaskSummary(task) {
  return {
    id: task.id,
    name: task.name,
    status: task.status?.status || task.status,
    priority: task.priority?.priority || task.priority,
    due_date: task.due_date ? new Date(parseInt(task.due_date)).toISOString() : null,
    date_updated: task.date_updated ? new Date(parseInt(task.date_updated)).toISOString() : null,
    list: task.list?.name,
    folder: task.folder?.name,
    space: task.space?.name,
    tags: task.tags?.map(t => t.name) || [],
    assignees: task.assignees?.map(a => a.username) || [],
    url: task.url
  };
}

/**
 * Format a full task detail including description and attachments.
 */
function formatTaskDetail(task) {
  const summary = formatTaskSummary(task);
  return {
    ...summary,
    description: task.description || task.text_content || '(no description)',
    markdown_description: task.markdown_description || null,
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

/**
 * Format comments for display, including reply threading and reactions.
 */
function formatComments(comments) {
  return comments.map(c => {
    const formatted = {
      id: c.id,
      author: c.user?.username || 'unknown',
      text: c.comment_text,
      date: c.date ? new Date(parseInt(c.date)).toISOString() : null,
      reply_count: c.reply_count || 0
    };
    if (c.parent) formatted.reply_to = c.parent;
    if (c.reactions?.length) {
      formatted.reactions = c.reactions.map(r => `${r.reaction} by ${r.user?.username || 'unknown'}`);
    }
    return formatted;
  });
}

// Tools exposed to the LLM via PTCClient
const TOOLS = [
  // --- ClickUp tools (routed through MCP with direct API fallback) ---
  {
    name: 'get_workspaces',
    description: 'List all workspaces the user belongs to.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_workspace_members',
    description: 'List all members (users) in a workspace. Use to find user IDs for task assignment.',
    input_schema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID (defaults to first workspace)' }
      }
    }
  },
  {
    name: 'list_spaces',
    description: 'List all spaces in a workspace.',
    input_schema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID (defaults to first workspace)' }
      }
    }
  },
  {
    name: 'list_folders',
    description: 'List all folders in a space.',
    input_schema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID' }
      },
      required: ['space_id']
    }
  },
  {
    name: 'list_lists',
    description: 'List lists in a folder (folder_id) or folderless lists in a space (space_id).',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder ID' },
        space_id: { type: 'string', description: 'Space ID (for folderless lists)' }
      }
    }
  },
  {
    name: 'list_tasks',
    description: 'Search and filter tasks. Supports assignees, statuses, tags, date ranges, and sorting.',
    input_schema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID (defaults to first workspace)' },
        assignees: { type: 'array', items: { type: 'number' }, description: 'Filter by user IDs' },
        statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by statuses' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag names' },
        list_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by list IDs' },
        due_date_gt: { type: 'number', description: 'Due after (unix ms)' },
        due_date_lt: { type: 'number', description: 'Due before (unix ms)' },
        order_by: { type: 'string', enum: ['created', 'updated', 'due_date'], description: 'Sort field' },
        reverse: { type: 'boolean', description: 'Sort descending' },
        include_closed: { type: 'boolean', description: 'Include closed tasks' },
        page: { type: 'number', description: 'Page (0-based)' }
      }
    }
  },
  {
    name: 'get_task',
    description: 'Get full details of a task including description and attachments.',
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'List ID to create task in' },
        name: { type: 'string', description: 'Task name' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', description: 'Status name' },
        priority: { type: 'number', description: '1=urgent, 2=high, 3=normal, 4=low' },
        assignees: { type: 'array', items: { type: 'number' }, description: 'User IDs to assign' },
        due_date: { type: 'number', description: 'Due date (unix ms)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names' }
      },
      required: ['list_id', 'name']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task (name, description, status, priority, assignees, due_date).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'number', description: '1=urgent, 2=high, 3=normal, 4=low' },
        assignees: {
          type: 'object',
          properties: {
            add: { type: 'array', items: { type: 'number' } },
            rem: { type: 'array', items: { type: 'number' } }
          }
        },
        due_date: { type: 'number' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID' },
        tag_name: { type: 'string', description: 'Tag name' }
      },
      required: ['task_id', 'tag_name']
    }
  },
  // --- Local meta-tools ---
  {
    name: 'prepare_download',
    description: 'Batch-fetch full details and comments for multiple tasks, then auto-delegate to pc-agent for downloading.',
    input_schema: {
      type: 'object',
      properties: {
        task_ids: { type: 'array', description: 'Array of task IDs to download' },
        target_dir: { type: 'string', description: 'Target directory (default: ~/Downloads/clickup-tasks)' }
      },
      required: ['task_ids']
    }
  },
  {
    name: 'ask_user_confirmation',
    description: 'Ask user for confirmation before a destructive action (delete, update, post comment). Do NOT use for listing, reading, or downloading.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to ask the user' }
      },
      required: ['question']
    }
  }
];

// Tools that route through MCP server (everything except local meta-tools)
const MCP_TOOLS = new Set([
  'get_workspaces', 'get_workspace_members', 'list_spaces', 'list_folders', 'list_lists',
  'list_tasks', 'get_task', 'create_task', 'update_task', 'delete_task',
  'get_comments', 'create_comment', 'list_tags', 'add_tag_to_task', 'remove_tag_from_task'
]);

export class ClickUpAgent extends BaseAgent {
  /**
   * @param {Object} options
   * @param {string} options.orchestratorUrl
   * @param {string} options.communicatorUrl
   * @param {string} options.apiKey - Communicator API key
   * @param {string} options.model - LLM model alias
   * @param {import('./clickup-client.js').ClickUpClient} options.clickup
   * @param {string} options.mcpUrl - MCP server URL
   * @param {number} options.userId - ClickUp user ID (fetched at startup)
   * @param {string} options.userName - ClickUp username
   * @param {Array<{id: string, name: string}>} options.workspaces
   * @param {number} [options.healthPort]
   */
  constructor(options) {
    super(
      {
        id: 'clickup',
        name: 'ClickUp Task Agent',
        capabilities: [
          'clickup project management',
          'clickup tasks and boards',
          'clickup workspace structure',
          'clickup task comments and attachments',
          'clickup inbox and activity',
          'clickup tags, spaces, folders, lists',
          'clickup team members and assignments'
        ],
        inputTypes: ['text'],
        healthEndpoint: '/health'
      },
      {
        orchestratorUrl: options.orchestratorUrl,
        healthPort: options.healthPort || 0
      }
    );

    this.communicatorUrl = options.communicatorUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.clickup = options.clickup;
    this.mcpUrl = options.mcpUrl;
    this.userId = options.userId;
    this.userName = options.userName;
    this.workspaces = options.workspaces;

    this.ptcClient = new PTCClient({
      communicatorUrl: options.communicatorUrl,
      apiKey: options.apiKey,
      model: options.model
    });
  }

  /**
   * Build the system prompt with workspace context injected.
   */
  buildSystemPrompt() {
    const workspaceList = this.workspaces
      .map(w => `  - "${w.name}" (id: ${w.id})`)
      .join('\n');

    return `You are a ClickUp task management agent. You help the user manage their ClickUp tasks, projects, and workspace.

Current user: ${this.userName} (id: ${this.userId})
Workspaces:
${workspaceList}

Rules:
- For listing tasks, present them clearly with task name, status, priority, due date, and assignees.
- For create_task, you need a list_id. If the user doesn't specify, use list_spaces -> list_folders -> list_lists to navigate the hierarchy and find the right list.
- For assigning tasks, first use get_workspace_members to find user IDs, then update_task with assignees.add/rem.
- Attachment URLs are signed and can be downloaded directly without authentication.
- If the user asks about "inbox" or "notifications", use list_tasks with order_by=updated and reverse=true.
- If the user asks to "complete" or "do" a task, first get_task to read details, then delegate_to_agent to hand it off to the right agent.
- Always use the user's workspace. If multiple, use the first unless specified.
- Never guess task IDs -- always list_tasks first if the user refers to tasks by name or number.
- Use ask_user_confirmation ONLY for destructive actions (delete, update, post comment). Never for listing, reading, downloading, or delegating.
- When listing tasks without specific filters, default to showing the user's own tasks (their user ID as assignee).
- For workspace hierarchy: workspace -> spaces -> folders -> lists -> tasks.`;
  }

  /**
   * Handle an incoming request from the orchestrator.
   */
  async handle(request) {
    const { requestId, text, context } = request;
    console.log(`[clickup] Handling request ${requestId}: ${text}`);

    try {
      const allTools = [...TOOLS];
      const delegationTool = this.buildDelegationTool(context?.availableAgents);
      if (delegationTool) allTools.push({ name: delegationTool.function.name, description: delegationTool.function.description, input_schema: delegationTool.function.parameters });
      const messages = this.buildMessagesWithHistory(this.buildSystemPrompt(), text || 'List my recent tasks', context?.sessionHistory, context?.globalInstructions, context?.autonomousInstructions);
      const result = await this.ptcClient.execute({
        messages,
        tools: allTools,
        toolExecutor: (name, input) => this.executeTool(name, input)
      });

      return {
        requestId,
        status: 'success',
        text: result.text
      };
    } catch (err) {
      if (err instanceof DelegationError) {
        console.log(`[clickup] Delegating to ${err.agentId}: ${err.query?.substring(0, 100)}...`);
        return {
          requestId,
          status: 'needs_agent',
          agentRequest: {
            targetAgentId: err.agentId,
            text: err.query,
            context: err.context
          }
        };
      }
      if (err instanceof DeviceInputError) {
        console.log(`[clickup] Asking user: ${err.deviceCommand.prompt}`);
        return {
          requestId,
          status: 'needs_input',
          deviceCommand: err.deviceCommand
        };
      }
      throw err;
    }
  }

  // --- MCP Integration ---

  /**
   * Check if the MCP server is alive via health endpoint.
   */
  async isMcpAlive() {
    try {
      const res = await fetch(`${this.mcpUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Call an MCP tool via HTTP (follows web-search agent pattern).
   */
  async callMCPTool(toolName, args) {
    const response = await fetch(`${this.mcpUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MCP HTTP ${response.status}: ${body}`);
    }

    const data = await response.json();

    if (data.result?.isError) {
      return `Error: ${data.result.content?.[0]?.text || 'Unknown error'}`;
    }

    const content = data.result?.content;
    if (Array.isArray(content)) {
      return content.map(c => c.text || '').join('\n');
    }

    return JSON.stringify(data.result);
  }

  // --- Tool Execution ---

  /**
   * Execute a tool by name. MCP-first for ClickUp tools, local for meta-tools.
   */
  async executeTool(toolName, args) {
    // Local meta-tools (never go through MCP)
    if (toolName === 'delegate_to_agent') {
      this.handleDelegation(args);
      return; // unreachable -- handleDelegation always throws
    }
    if (toolName === 'ask_user_confirmation') {
      if (!args.question) return 'Error: missing "question" argument';
      throw new DeviceInputError({ type: 'confirm', prompt: args.question, timeout: 60000 });
    }
    if (toolName === 'prepare_download') {
      return this.executePrepareDownload(args);
    }

    // ClickUp tools: MCP first, fallback to direct API
    if (MCP_TOOLS.has(toolName)) {
      // Inject default workspace_id where needed
      if (!args.workspace_id && ['list_tasks', 'get_workspace_members', 'list_spaces'].includes(toolName)) {
        args.workspace_id = this.workspaces[0]?.id;
      }

      if (await this.isMcpAlive()) {
        try {
          console.log(`[clickup] MCP call: ${toolName}`);
          return await this.callMCPTool(toolName, args);
        } catch (err) {
          console.log(`[clickup] MCP failed for ${toolName}: ${err.message}, falling back to direct API`);
        }
      } else {
        console.log(`[clickup] MCP unavailable, using direct API for ${toolName}`);
      }

      return this.executeDirectApi(toolName, args);
    }

    return `Unknown tool: ${toolName}`;
  }

  /**
   * Execute a ClickUp tool via direct API (fallback when MCP is down).
   */
  async executeDirectApi(toolName, args) {
    const defaultWorkspaceId = this.workspaces[0]?.id;

    switch (toolName) {
      case 'get_workspaces': {
        const workspaces = await this.clickup.getWorkspaces();
        return JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })), null, 2);
      }

      case 'get_workspace_members': {
        const data = await this.clickup.getWorkspaceMembers(args.workspace_id || defaultWorkspaceId);
        const members = (data.members || []).map(m => ({
          id: m.user?.id, username: m.user?.username, email: m.user?.email, role: m.role?.name || m.role
        }));
        return JSON.stringify(members, null, 2);
      }

      case 'list_spaces': {
        const data = await this.clickup.listSpaces(args.workspace_id || defaultWorkspaceId);
        const spaces = (data.spaces || []).map(s => ({ id: s.id, name: s.name, private: s.private }));
        return JSON.stringify(spaces, null, 2);
      }

      case 'list_folders': {
        if (!args.space_id) return 'Error: missing "space_id"';
        const data = await this.clickup.listFolders(args.space_id);
        const folders = (data.folders || []).map(f => ({ id: f.id, name: f.name, list_count: f.lists?.length || 0 }));
        return JSON.stringify(folders, null, 2);
      }

      case 'list_lists': {
        let data;
        if (args.folder_id) {
          data = await this.clickup.listLists(args.folder_id);
        } else if (args.space_id) {
          data = await this.clickup.getFolderlessLists(args.space_id);
        } else {
          return 'Error: provide either folder_id or space_id';
        }
        const lists = (data.lists || []).map(l => ({ id: l.id, name: l.name, task_count: l.task_count }));
        return JSON.stringify(lists, null, 2);
      }

      case 'list_tasks': {
        const workspaceId = args.workspace_id || defaultWorkspaceId;
        if (!workspaceId) return 'Error: no workspace available';

        const data = await this.clickup.getFilteredTasks(workspaceId, {
          assignees: args.assignees || [this.userId],
          statuses: args.statuses,
          tags: args.tags,
          list_ids: args.list_ids,
          due_date_gt: args.due_date_gt,
          due_date_lt: args.due_date_lt,
          orderBy: args.order_by || 'updated',
          reverse: args.reverse !== undefined ? args.reverse : true,
          includeClosed: args.include_closed || false,
          page: args.page || 0
        });

        const tasks = (data.tasks || []).map(formatTaskSummary);
        if (tasks.length === 0) return 'No tasks found matching the criteria.';
        return JSON.stringify(tasks, null, 2);
      }

      case 'get_task': {
        if (!args.task_id) return 'Error: missing "task_id"';
        const task = await this.clickup.getTask(args.task_id);
        return JSON.stringify(formatTaskDetail(task), null, 2);
      }

      case 'create_task': {
        if (!args.list_id) return 'Error: missing "list_id"';
        if (!args.name) return 'Error: missing "name"';
        const taskData = { name: args.name };
        if (args.description) taskData.description = args.description;
        if (args.status) taskData.status = args.status;
        if (args.priority) taskData.priority = args.priority;
        if (args.assignees) taskData.assignees = args.assignees;
        if (args.due_date) taskData.due_date = args.due_date;
        if (args.tags) taskData.tags = args.tags;
        const task = await this.clickup.createTask(args.list_id, taskData);
        return JSON.stringify({ id: task.id, name: task.name, status: task.status?.status, url: task.url }, null, 2);
      }

      case 'update_task': {
        if (!args.task_id) return 'Error: missing "task_id"';
        const updates = {};
        if (args.name) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.status) updates.status = args.status;
        if (args.priority) updates.priority = args.priority;
        if (args.assignees) updates.assignees = args.assignees;
        if (args.due_date) updates.due_date = args.due_date;
        const result = await this.clickup.updateTask(args.task_id, updates);
        return `Task updated. Status: ${result.status?.status || 'unknown'}`;
      }

      case 'delete_task': {
        if (!args.task_id) return 'Error: missing "task_id"';
        await this.clickup.deleteTask(args.task_id);
        return `Task ${args.task_id} deleted.`;
      }

      case 'get_comments': {
        if (!args.task_id) return 'Error: missing "task_id"';
        const data = await this.clickup.getComments(args.task_id);
        const comments = formatComments(data.comments || []);
        if (comments.length === 0) return 'No comments on this task.';
        return JSON.stringify(comments, null, 2);
      }

      case 'create_comment': {
        if (!args.task_id) return 'Error: missing "task_id"';
        if (!args.comment_text) return 'Error: missing "comment_text"';
        await this.clickup.postComment(args.task_id, args.comment_text);
        return 'Comment posted successfully.';
      }

      case 'list_tags': {
        if (!args.space_id) return 'Error: missing "space_id"';
        const data = await this.clickup.listSpaceTags(args.space_id);
        return JSON.stringify((data.tags || []).map(t => ({ name: t.name })), null, 2);
      }

      case 'add_tag_to_task': {
        if (!args.task_id || !args.tag_name) return 'Error: missing "task_id" or "tag_name"';
        await this.clickup.addTagToTask(args.task_id, args.tag_name);
        return `Tag "${args.tag_name}" added to task.`;
      }

      case 'remove_tag_from_task': {
        if (!args.task_id || !args.tag_name) return 'Error: missing "task_id" or "tag_name"';
        await this.clickup.removeTagFromTask(args.task_id, args.tag_name);
        return `Tag "${args.tag_name}" removed from task.`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  /**
   * Prepare download script and delegate to pc-agent (always uses direct API for raw data).
   */
  async executePrepareDownload(args) {
    if (!args.task_ids || !args.task_ids.length) return 'Error: missing "task_ids" argument';
    const rootDir = args.target_dir || '~/Downloads/clickup-tasks';

    const scriptLines = ['#!/bin/bash', 'set -e', ''];

    for (const taskId of args.task_ids) {
      console.log(`[clickup] prepare_download: fetching task ${taskId}`);
      const task = await this.clickup.getTask(taskId);
      const detail = formatTaskDetail(task);

      const folderName = `${detail.name}`.replace(/[/\\:*?"<>|'`$!(){}]/g, '-').substring(0, 100);
      const folderPath = `${rootDir}/${folderName}`;

      const descContent = [
        `Title: ${detail.name}`,
        `Status: ${detail.status}`,
        `Priority: ${detail.priority || 'none'}`,
        `Assignees: ${detail.assignees.join(', ') || 'none'}`,
        `Due Date: ${detail.due_date || 'none'}`,
        `Updated: ${detail.date_updated || 'unknown'}`,
        `URL: ${detail.url}`,
        `List: ${detail.list || ''} / Folder: ${detail.folder || ''} / Space: ${detail.space || ''}`,
        `Tags: ${detail.tags.join(', ') || 'none'}`,
        '',
        '--- Description ---',
        '',
        detail.markdown_description || detail.description
      ].join('\n');

      let commentsData;
      try { commentsData = await this.clickup.getComments(taskId); }
      catch { commentsData = { comments: [] }; }
      const comments = commentsData.comments || [];

      let commentsContent;
      if (comments.length === 0) {
        commentsContent = 'No comments on this task.';
      } else {
        const sorted = [...comments].sort((a, b) => parseInt(a.date || 0) - parseInt(b.date || 0));
        const authorMap = {};
        for (const c of sorted) authorMap[c.id] = c.user?.username || 'unknown';

        const lines = [];
        for (const c of sorted) {
          const timestamp = c.date ? new Date(parseInt(c.date)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'unknown time';
          const author = c.user?.username || 'unknown';
          const isReply = !!c.parent;
          const prefix = isReply ? '  > ' : '';
          const replyNote = isReply ? ` (Reply to ${authorMap[c.parent] || 'comment ' + c.parent})` : '';

          lines.push(`${prefix}[${timestamp}] ${author}${replyNote}:`);
          for (const line of (c.comment_text || '').split('\n')) {
            lines.push(`${prefix}  ${line}`);
          }
          if (c.reactions?.length) {
            const rxns = c.reactions.map(r => `${r.reaction} (${r.user?.username || '?'})`).join(', ');
            lines.push(`${prefix}  Reactions: ${rxns}`);
          }
          lines.push('');
        }
        commentsContent = lines.join('\n');
      }

      scriptLines.push(`# --- Task: ${detail.name} ---`);
      scriptLines.push(`mkdir -p "${folderPath}"`);
      scriptLines.push(`cat > "${folderPath}/description.txt" << 'CLICKUP_DESC_EOF'`);
      scriptLines.push(descContent);
      scriptLines.push('CLICKUP_DESC_EOF');
      scriptLines.push(`cat > "${folderPath}/comments.txt" << 'CLICKUP_COMMENTS_EOF'`);
      scriptLines.push(commentsContent);
      scriptLines.push('CLICKUP_COMMENTS_EOF');

      const attachments = detail.attachments || [];
      for (const att of attachments) {
        const ext = (att.type || att.title || '').toLowerCase();
        const isVideo = /mp4|mov|avi|mkv|webm/.test(ext);
        const isPhoto = /jpg|jpeg|png|gif|webp|bmp/.test(ext);
        const subdir = isVideo ? 'videos' : isPhoto ? 'photos' : '';
        const targetDir = subdir ? `${folderPath}/${subdir}` : folderPath;
        const fileName = (att.title || `attachment_${att.id}`).replace(/['"$`!]/g, '');

        if (subdir) scriptLines.push(`mkdir -p "${targetDir}"`);
        scriptLines.push(`curl -sL "${att.url}" -o "${targetDir}/${fileName}" --max-time 120`);
      }
      scriptLines.push('');
    }

    scriptLines.push('echo "All tasks downloaded successfully."');
    const script = scriptLines.join('\n');

    throw new DelegationError('pc-agent',
      `Run this bash script to completion. Execute it as a single command using bash:\n\nbash <<'CLICKUP_SCRIPT'\n${script}\nCLICKUP_SCRIPT`,
      {}
    );
  }
}
