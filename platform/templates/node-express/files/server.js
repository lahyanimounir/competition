const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT; // assigned by the platform - never hardcode a port
if (!PORT) {
  console.error('PORT is not set. Locally run:  PORT=3000 npm start   (PowerShell: $env:PORT=3000; npm start)');
  process.exit(1);
}

const app = express();
app.use(cors()); // allow a separately deployed front end to call this API
app.use(express.json());
app.use(express.static('public'));

// REST starter: an in-memory list of items
let nextId = 3;
const items = [{ id: 1, title: 'First item' }, { id: 2, title: 'Second item' }];

app.get('/api/items', (req, res) => res.json(items));
app.get('/api/items/:id', (req, res) => {
  const item = items.find((i) => i.id === Number(req.params.id));
  item ? res.json(item) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/items', (req, res) => {
  if (!req.body.title) return res.status(422).json({ error: 'title is required' });
  const item = { id: nextId++, title: req.body.title };
  items.push(item);
  res.status(201).json(item);
});
app.delete('/api/items/:id', (req, res) => {
  const i = items.findIndex((x) => x.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  items.splice(i, 1);
  res.status(204).end();
});

// Database check using the credentials the platform injects for this repository
app.get('/api/db-check', async (req, res) => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
    });
    const [rows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db');
    await conn.end();
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(Number(PORT), '0.0.0.0', () => console.log(`Listening on 0.0.0.0:${PORT}`));
