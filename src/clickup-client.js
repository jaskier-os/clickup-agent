/**
 * ClickUp API v2 client.
 * Wraps all REST calls with auth header injection.
 *
 * Rate limit: 100 req/min on free/business plans.
 * All methods throw on HTTP errors with status code and body.
 */

const BASE_URL = 'https://api.clickup.com';

export class ClickUpClient {
  /**
   * @param {string} apiKey - ClickUp personal API token (pk_...)
   * @param {import('undici').Dispatcher} [dispatcher] - Optional proxy dispatcher for fetch
   */
  constructor(apiKey, dispatcher = null) {
    this.apiKey = apiKey;
    this.dispatcher = dispatcher;
  }

  /**
   * Make an authenticated request to ClickUp API.
   * @param {string} path - API path (e.g. '/api/v2/user')
   * @param {Object} [options] - fetch options override
   * @returns {Promise<any>} parsed JSON response
   */
  async request(path, options = {}) {
    const url = `${BASE_URL}${path}`;
    const fetchOptions = {
      ...options,
      headers: {
        'Authorization': this.apiKey,
        'Content-Type': 'application/json',
        ...options.headers
      }
    };
    if (this.dispatcher) {
      fetchOptions.dispatcher = this.dispatcher;
    }
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ClickUp API ${response.status}: ${body}`);
    }

    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  }

  // --- Identity ---

  /**
   * Get authenticated user info.
   * @returns {Promise<{ id: number, username: string, email: string }>}
   */
  async getUser() {
    const data = await this.request('/api/v2/user');
    return data.user;
  }

  /**
   * Get all workspaces the user belongs to.
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  async getWorkspaces() {
    const data = await this.request('/api/v2/team');
    return data.teams;
  }

  // --- Workspace ---

  /**
   * Get members of a workspace.
   * Members are included in the workspace (team) data from /api/v2/team.
   * @param {string} teamId - Workspace ID
   * @returns {Promise<{ members: Array }>}
   */
  async getWorkspaceMembers(teamId) {
    const data = await this.request('/api/v2/team');
    const team = data.teams.find(t => t.id === teamId || t.id === String(teamId));
    if (!team) throw new Error(`Workspace ${teamId} not found`);
    return { members: team.members || [] };
  }

  // --- Spaces ---

  /**
   * List all spaces in a workspace.
   * @param {string} teamId - Workspace ID
   * @returns {Promise<{ spaces: Array }>}
   */
  async listSpaces(teamId) {
    return this.request(`/api/v2/team/${teamId}/space?archived=false`);
  }

  // --- Folders ---

  /**
   * List all folders in a space.
   * @param {string} spaceId
   * @returns {Promise<{ folders: Array }>}
   */
  async listFolders(spaceId) {
    return this.request(`/api/v2/space/${spaceId}/folder`);
  }

  // --- Lists ---

  /**
   * List lists in a folder.
   * @param {string} folderId
   * @returns {Promise<{ lists: Array }>}
   */
  async listLists(folderId) {
    return this.request(`/api/v2/folder/${folderId}/list`);
  }

  /**
   * List folderless lists in a space.
   * @param {string} spaceId
   * @returns {Promise<{ lists: Array }>}
   */
  async getFolderlessLists(spaceId) {
    return this.request(`/api/v2/space/${spaceId}/list`);
  }

  // --- Tasks ---

  /**
   * List tasks with full filtering support.
   * @param {string} teamId - Workspace ID
   * @param {Object} [filters]
   * @param {number[]} [filters.assignees] - Filter by user IDs
   * @param {string[]} [filters.statuses] - Filter by status names
   * @param {string[]} [filters.tags] - Filter by tag names
   * @param {string[]} [filters.list_ids] - Filter by list IDs
   * @param {boolean} [filters.includeClosed] - Include closed tasks
   * @param {number} [filters.page] - Page number (0-indexed, 100 per page)
   * @param {string} [filters.orderBy] - Sort field (created, updated, due_date)
   * @param {boolean} [filters.reverse] - Reverse sort order
   * @param {boolean} [filters.subtasks] - Include subtasks
   * @param {number} [filters.due_date_gt] - Due date after (unix ms)
   * @param {number} [filters.due_date_lt] - Due date before (unix ms)
   * @param {number} [filters.date_updated_gt] - Updated after (unix ms)
   * @param {number} [filters.date_updated_lt] - Updated before (unix ms)
   * @returns {Promise<{ tasks: Array }>}
   */
  async getFilteredTasks(teamId, filters = {}) {
    const params = new URLSearchParams();
    params.append('page', (filters.page || 0).toString());
    params.append('subtasks', (filters.subtasks !== undefined ? filters.subtasks : true).toString());
    params.append('include_closed', (filters.includeClosed !== undefined ? filters.includeClosed : false).toString());

    if (filters.assignees) {
      for (const id of filters.assignees) params.append('assignees[]', id.toString());
    }
    if (filters.statuses) {
      for (const s of filters.statuses) params.append('statuses[]', s);
    }
    if (filters.tags) {
      for (const t of filters.tags) params.append('tags[]', t);
    }
    if (filters.list_ids) {
      for (const id of filters.list_ids) params.append('list_ids[]', id);
    }
    if (filters.orderBy) {
      params.append('order_by', filters.orderBy);
      if (filters.reverse !== undefined) params.append('reverse', filters.reverse.toString());
    }
    if (filters.due_date_gt) params.append('due_date_gt', filters.due_date_gt.toString());
    if (filters.due_date_lt) params.append('due_date_lt', filters.due_date_lt.toString());
    if (filters.date_updated_gt) params.append('date_updated_gt', filters.date_updated_gt.toString());
    if (filters.date_updated_lt) params.append('date_updated_lt', filters.date_updated_lt.toString());

    return this.request(`/api/v2/team/${teamId}/task?${params.toString()}`);
  }

  /**
   * List tasks assigned to a user in a workspace (legacy convenience wrapper).
   * @param {string} teamId - Workspace ID
   * @param {number} userId - User ID to filter by
   * @param {Object} [filters]
   * @returns {Promise<{ tasks: Array }>}
   */
  async listTasks(teamId, userId, filters = {}) {
    return this.getFilteredTasks(teamId, {
      assignees: [userId],
      includeClosed: filters.includeClosed !== undefined ? filters.includeClosed : true,
      page: filters.page,
      orderBy: filters.orderBy,
      reverse: filters.reverse,
      statuses: filters.statuses,
      subtasks: true
    });
  }

  /**
   * Create a task in a list.
   * @param {string} listId
   * @param {Object} data - Task data
   * @param {string} data.name - Task name (required)
   * @param {string} [data.description] - Task description
   * @param {string} [data.status] - Status name
   * @param {number} [data.priority] - Priority 1-4 (1=urgent, 4=low)
   * @param {number[]} [data.assignees] - Array of user IDs
   * @param {number} [data.due_date] - Due date in unix ms
   * @param {string[]} [data.tags] - Tag names
   * @returns {Promise<Object>}
   */
  async createTask(listId, data) {
    return this.request(`/api/v2/list/${listId}/task`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  /**
   * Delete a task.
   * @param {string} taskId
   * @returns {Promise<Object>}
   */
  async deleteTask(taskId) {
    return this.request(`/api/v2/task/${taskId}`, { method: 'DELETE' });
  }

  /**
   * Get a single task by ID (includes attachments array).
   * @param {string} taskId
   * @returns {Promise<Object>} full task object with attachments
   */
  async getTask(taskId) {
    return this.request(`/api/v2/task/${taskId}`);
  }

  /**
   * Get comments on a task.
   * @param {string} taskId
   * @param {Object} [pagination]
   * @param {number} [pagination.start] - Unix ms timestamp for pagination
   * @param {string} [pagination.startId] - Comment ID for pagination
   * @returns {Promise<{ comments: Array }>}
   */
  async getComments(taskId, pagination = {}) {
    const params = new URLSearchParams();
    if (pagination.start !== undefined) params.append('start', pagination.start.toString());
    if (pagination.startId) params.append('start_id', pagination.startId);

    const query = params.toString();
    const path = `/api/v2/task/${taskId}/comment${query ? '?' + query : ''}`;
    return this.request(path);
  }

  /**
   * Update a task (status, name, description, etc.).
   * @param {string} taskId
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateTask(taskId, updates) {
    return this.request(`/api/v2/task/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  /**
   * Post a comment on a task.
   * @param {string} taskId
   * @param {string} commentText
   * @returns {Promise<Object>}
   */
  async postComment(taskId, commentText) {
    return this.request(`/api/v2/task/${taskId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ comment_text: commentText })
    });
  }

  /**
   * Get recently updated tasks (inbox workaround).
   * ClickUp has no inbox API, so this fetches tasks sorted by last update.
   * @param {string} teamId - Workspace ID
   * @param {number} userId - User ID
   * @param {number} [pages] - How many pages to fetch (1 page = 100 tasks)
   * @returns {Promise<Array>}
   */
  async getRecentActivity(teamId, userId, pages = 1) {
    const allTasks = [];
    for (let page = 0; page < pages; page++) {
      const data = await this.listTasks(teamId, userId, {
        includeClosed: false,
        orderBy: 'updated',
        reverse: true,
        page
      });
      allTasks.push(...(data.tasks || []));
      if (!data.tasks || data.tasks.length < 100) break;
    }
    return allTasks;
  }

  // --- Tags ---

  /**
   * List all tags in a space.
   * @param {string} spaceId
   * @returns {Promise<{ tags: Array }>}
   */
  async listSpaceTags(spaceId) {
    return this.request(`/api/v2/space/${spaceId}/tag`);
  }

  /**
   * Add a tag to a task.
   * @param {string} taskId
   * @param {string} tagName
   * @returns {Promise<Object>}
   */
  async addTagToTask(taskId, tagName) {
    return this.request(`/api/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  /**
   * Remove a tag from a task.
   * @param {string} taskId
   * @param {string} tagName
   * @returns {Promise<Object>}
   */
  async removeTagFromTask(taskId, tagName) {
    return this.request(`/api/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
      method: 'DELETE'
    });
  }
}
