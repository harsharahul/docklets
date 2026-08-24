// guestbook docklet: static frontend + JSON API + persistent /data.
// Zero dependencies (node:http only) so no npm install step is needed.
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 3000);
const DB = '/data/messages.json';

const load = () => {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; }
};
const save = (msgs) => fs.writeFileSync(DB, JSON.stringify(msgs, null, 2));

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guestbook (docklet demo)</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem}
  h1{font-size:1.5rem}
  small{opacity:.6}
  form{display:flex;gap:.5rem;margin:1rem 0}
  input{flex:1;padding:.55rem .7rem;border:1px solid #8884;border-radius:8px;background:transparent;color:inherit}
  button{padding:.55rem .9rem;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
  ul{list-style:none;padding:0}
  li{padding:.55rem .7rem;border:1px solid #8883;border-radius:8px;margin:.4rem 0}
  li small{display:block;margin-top:.15rem}
</style></head><body>
<h1>📬 Guestbook</h1>
<small>server-side docklet: messages persist in /data across restarts, visible to <em>every</em> visitor</small>
<form id="f"><input id="m" placeholder="Leave a message…" maxlength="200" required><button>Post</button></form>
<ul id="list"></ul>
<script>
  const list = document.getElementById('list');
  async function refresh(){
    const msgs = await (await fetch('api/messages')).json();
    list.innerHTML = msgs.slice().reverse().map(m =>
      '<li>' + m.text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) +
      '<small>' + new Date(m.at).toLocaleString() + '</small></li>').join('');
  }
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const inp = document.getElementById('m');
    await fetch('api/messages', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({text: inp.value.trim()})});
    inp.value = ''; refresh();
  };
  refresh();
</script></body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/messages' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(load()));
  }
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (typeof text !== 'string' || !text.trim() || text.length > 200) throw 0;
        const msgs = load();
        msgs.push({ text: text.trim(), at: new Date().toISOString() });
        save(msgs.slice(-100));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end();
      }
    });
    return;
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, () => console.log('guestbook listening on', PORT));
