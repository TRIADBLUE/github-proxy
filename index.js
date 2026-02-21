const express = require('express');
const app = express();

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;

// Proxy all /api/github/* requests to consoleblue
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
  res.json({ status: 'ok', service: 'consoleblue-github-proxy', version: '1.1' });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
