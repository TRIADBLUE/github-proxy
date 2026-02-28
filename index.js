const express = require('express');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const app = express();
app.use(express.json());

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;
const GITHUB_ORG = process.env.GITHUB_ORG || 'TRIADBLUE';
const GITHUB_API = 'https://api.github.com';

// --- GitHub API helper ---
function ghHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'consoleblue-github-proxy/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function ghFetch(path) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

// --- MCP Server setup ---
function createMcpServer() {
  const server = new McpServer({
    name: 'triadblue-github',
    version: '1.0.0',
  });

  // List all repos
  server.tool('list_repos', 'List all repositories in the TRIADBLUE org', {}, async () => {
    const repos = await ghFetch(`/orgs/${GITHUB_ORG}/repos?per_page=100`);
    const summary = repos.map(r => ({
      name: r.name,
      description: r.description,
      language: r.language,
      updated_at: r.updated_at,
      html_url: r.html_url,
      default_branch: r.default_branch,
      private: r.private,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  });

  // Get repo details
  server.tool('get_repo', 'Get details about a specific repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  // List directory contents
  server.tool('list_files', 'List files and directories in a repo path', {
    repo: z.string().describe('Repository name'),
    path: z.string().optional().describe('Directory path (empty for root)'),
  }, async ({ repo, path }) => {
    const p = path || '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${p}`);
    const listing = Array.isArray(data)
      ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
    return { content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }] };
  });

  // Read a file
  server.tool('read_file', 'Read the contents of a file in a repo', {
    repo: z.string().describe('Repository name'),
    path: z.string().describe('File path'),
  }, async ({ repo, path }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') {
      return { content: [{ type: 'text', text: `Error: ${path} is a ${data.type}, not a file` }], isError: true };
    }
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: [{ type: 'text', text: content }] };
  });

  // List branches
  server.tool('list_branches', 'List branches of a repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/branches?per_page=100`);
    const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
    return { content: [{ type: 'text', text: JSON.stringify(branches, null, 2) }] };
  });

  // List issues
  server.tool('list_issues', 'List open issues for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/issues?state=${s}&per_page=50`);
    const issues = data.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user.login,
      created_at: i.created_at,
      labels: i.labels.map(l => l.name),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
  });

  // List pull requests
  server.tool('list_pulls', 'List pull requests for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/pulls?state=${s}&per_page=50`);
    const prs = data.map(p => ({
      number: p.number,
      title: p.title,
      state: p.state,
      user: p.user.login,
      created_at: p.created_at,
      head: p.head.ref,
      base: p.base.ref,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(prs, null, 2) }] };
  });

  // Search code in the org
  server.tool('search_code', 'Search for code across all TRIADBLUE repos', {
    query: z.string().describe('Search query (code, filename, etc.)'),
  }, async ({ query }) => {
    const data = await ghFetch(`/search/code?q=${encodeURIComponent(query)}+org:${GITHUB_ORG}&per_page=20`);
    const results = data.items.map(i => ({
      repo: i.repository.full_name,
      file: i.path,
      url: i.html_url,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  });

  // Get commit history
  server.tool('list_commits', 'List recent commits for a repo', {
    repo: z.string().describe('Repository name'),
    branch: z.string().optional().describe('Branch name (defaults to main)'),
  }, async ({ repo, branch }) => {
    const b = branch ? `&sha=${branch}` : '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/commits?per_page=20${b}`);
    const commits = data.map(c => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(commits, null, 2) }] };
  });

  return server;
}

// --- MCP HTTP endpoint (stateful) ---
const sessions = new Map(); // sessionId -> { server, transport }

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(m => m.method === 'initialize');
  return body?.method === 'initialize';
}

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      let assignedSessionId;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => {
          assignedSessionId = crypto.randomUUID();
          return assignedSessionId;
        },
      });
      const server = createMcpServer();

      transport.onclose = () => {
        if (assignedSessionId) sessions.delete(assignedSessionId);
        console.log(`MCP session closed: ${assignedSessionId}`);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (assignedSessionId) {
        sessions.set(assignedSessionId, { server, transport });
        console.log(`MCP session created: ${assignedSessionId}`);
      }
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad request — missing or invalid session' },
      id: null,
    });
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session' }, id: null });
    return;
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session' }, id: null });
    return;
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

// --- CORS preflight for all routes ---
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization, mcp-session-id');
  res.sendStatus(204);
});

// --- /repos — direct GitHub API ---
app.get('/api/github/repos', async (req, res) => {
  const url = `https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100`;
  console.log(`GITHUB API → GET ${url}`);
  try {
    const response = await fetch(url, { headers: ghHeaders() });
    const data = await response.text();
    console.log(`GITHUB API ← ${response.status} (${data.length} bytes)`);
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(data);
  } catch (err) {
    console.error(`GITHUB API ERROR: ${err.message}`);
    res.status(502).json({ error: 'GitHub API error', message: err.message });
  }
});

// --- Proxy all other /api/github/* to consoleblue ---
app.use('/api/github', async (req, res) => {
  const url = `${TARGET}${req.originalUrl}`;
  console.log(`PROXY → ${req.method} ${url}`);
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'x-api-key': req.query.api_key || req.headers['x-api-key'] || '',
        'content-type': 'application/json',
        'user-agent': 'consoleblue-github-proxy/1.0',
      },
    });
    const data = await response.text();
    console.log(`PROXY ← ${response.status} (${data.length} bytes)`);
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(data);
  } catch (err) {
    console.error(`PROXY ERROR: ${err.message}`);
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

// --- Health check ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'consoleblue-github-proxy', version: '2.0', mcp: '/mcp' });
});

app.listen(PORT, () => {
  console.log(`Proxy + MCP server running on port ${PORT}`);
});
