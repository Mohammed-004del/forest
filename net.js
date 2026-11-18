// Slow connections: the host drops downloads that run for minutes, and one dropped HTTP/2 connection kills
// every file in flight. So assets come down in 4 MB pieces, a few at a time, and a piece that fails is retried.
const CHUNK = 4 << 20, MAX = 4, TRIES = 6;
const raw = window.fetch.bind(window);
let active = 0;
const queue = [];
const slot = () => new Promise((go) => (active < MAX ? (active++, go()) : queue.push(go)));
const free = () => (queue.length ? queue.shift()() : active--);

async function piece(url, from, to) {
  for (let i = 0; ; i++) {
    await slot();
    try {
      const r = await raw(url, { headers: { Range: `bytes=${from}-${to}` } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return { r, buf: await r.arrayBuffer() };
    } catch (e) {
      if (i >= TRIES) throw e;
    } finally {
      free();
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
}

window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.includes('/assets/') || (init?.method && init.method !== 'GET')) return raw(input, init);
  const first = await piece(url.href, 0, CHUNK - 1);
  const type = first.r.headers.get('content-type') || '';
  // 206: the server sent a piece and tells the full size; 200: it ignored Range and sent the whole file
  const total = first.r.status === 206 ? +first.r.headers.get('content-range').split('/')[1] : first.buf.byteLength;
  const rest = [];
  for (let from = CHUNK; from < total; from += CHUNK) rest.push(piece(url.href, from, Math.min(total, from + CHUNK) - 1).then((p) => p.buf));
  const parts = [first.buf, ...(await Promise.all(rest))];
  return new Response(new Blob(parts, { type }), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(total) } });
};
