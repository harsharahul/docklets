// The guestbook as a worker docklet: a page, a JSON API, and messages kept
// in the docklet's own database (env.DB) instead of a /data folder.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guestbook</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem}
  form{display:flex;gap:.5rem;margin:1rem 0}
  input{flex:1;padding:.55rem .7rem;border:1px solid #8884;border-radius:8px;background:transparent;color:inherit}
  button{padding:.55rem .9rem;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
  ul{list-style:none;padding:0}
  li{padding:.55rem .7rem;border:1px solid #8883;border-radius:8px;margin:.4rem 0}
  small{display:block;opacity:.6;margin-top:.15rem}
</style></head><body>
<h1>Guestbook</h1>
<form id="f"><input id="m" placeholder="Leave a message" maxlength="200" required><button>Post</button></form>
<ul id="list"></ul>
<script>
  const list = document.getElementById('list');
  const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  async function refresh() {
    const msgs = await (await fetch('api/messages')).json();
    list.innerHTML = msgs.map((m) => '<li>' + esc(m.text) + '<small>' + new Date(m.at).toLocaleString() + '</small></li>').join('');
  }
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const m = document.getElementById('m');
    await fetch('api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: m.value }) });
    m.value = ''; refresh();
  };
  refresh();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true });
    if (url.pathname === '/api/messages') {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)');
      if (request.method === 'POST') {
        const { text } = await request.json().catch(() => ({}));
        if (typeof text !== 'string' || !text.trim() || text.length > 200) {
          return Response.json({ error: 'text is required, up to 200 characters' }, { status: 400 });
        }
        const { lastId } = await env.DB.exec('INSERT INTO messages (text, at) VALUES (?, ?)', [text.trim(), new Date().toISOString()]);
        return Response.json({ id: lastId }, { status: 201 });
      }
      return Response.json(await env.DB.query('SELECT id, text, at FROM messages ORDER BY id DESC LIMIT 50'));
    }
    return new Response('not found', { status: 404 });
  },
};
