const express = require('express');
const app = express();

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;

// Proxy all /api/github/* requests to consoleblue
app.use('/api/github', async (req, res) => {
  const url = `${TARGET}${req.originalUrl}`;
  
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'x-api-key': req.query.api_key || req.headers['x-api-key'] || '',
        'content-type': 'application/json',
      },
    });

    const data = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.send(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'consoleblue-github-proxy' });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
