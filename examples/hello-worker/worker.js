// A worker docklet: one fetch handler, Workers style. Requests arrive with
// the /<slug>/ prefix stripped; the prefix itself rides in a header.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(`${env.GREETING}\n\nTry /echo?name=you or POST a body to /echo.\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (url.pathname === '/echo') {
      return Response.json({
        method: request.method,
        path: url.pathname + url.search,
        prefix: request.headers.get('x-docklets-prefix'),
        name: url.searchParams.get('name'),
        body: request.method === 'POST' ? await request.text() : null,
      });
    }
    return new Response('not found', { status: 404 });
  },
};
