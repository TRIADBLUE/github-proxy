const express = require('express');
const app = express();

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;
const GITHUB_ORG = process.env.GITHUB_ORG || 'TRIADBLUE';

// CORS preflight for all routes
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.sendStatus(204);
});

// /repos — query GitHub API directly for the org's repos
app.get('/api/github/repos', async (req, res) => {
  const url = `https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100`;

  console.log(`GITHUB API → GET ${url}`);

  try {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'consoleblue-github-proxy/1.0',
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(url, { headers });
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

// Proxy all other /api/github/* requests to consoleblue
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'consoleblue-github-proxy', version: '1.2' });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
