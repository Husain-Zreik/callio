// Serves the SDK folder so examples/agent.html can load the SDK as ES
// modules (browsers don't load modules from file://). localhost counts as a
// secure origin, so the microphone works.
//
//   node sdk/agent-js/examples/serve.mjs [port]    → http://localhost:5173/examples/agent.html
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 5173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };

http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(root, path || 'examples/agent.html');
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(port, '127.0.0.1', () => {
    console.log(`Callio agent demo: http://localhost:${port}/examples/agent.html`);
});
