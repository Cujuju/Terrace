// Tiny CDP helper for the gate 2 battery runs.
//   node cdp.mjs size <urlSubstring>          resize window so the viewport is 1200x900
//   node cdp.mjs eval <urlSubstring> <expr>   print JSON of the expression's value
//   node cdp.mjs targets                      list page targets
const PORT = process.env.CDP_PORT ?? '9222';
const TIMEOUT_MS = 30_000;
const [cmd, match, expr] = process.argv.slice(2);

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let nextId = 1;
const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${method}: timeout`)), TIMEOUT_MS);
  const listener = (event) => {
    const m = JSON.parse(event.data);
    if (m.id !== id) return;
    clearTimeout(timer);
    socket.removeEventListener('message', listener);
    m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
  };
  socket.addEventListener('message', listener);
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetInfos } = await rpc('Target.getTargets');
const pages = targetInfos.filter((t) => t.type === 'page');
if (cmd === 'targets') {
  console.log(JSON.stringify(pages.map((t) => t.url)));
  process.exit(0);
}
const page = pages.find((t) => t.url.includes(match));
if (!page) throw new Error(`no page target matching ${match}; have ${pages.map((t) => t.url).join(', ')}`);
const { sessionId } = await rpc('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const evaluate = async (expression) => {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(expr)));
} else if (cmd === 'size') {
  const { windowId } = await rpc('Browser.getWindowForTarget', { targetId: page.targetId });
  for (let i = 0; i < 3; i++) {
    const [w, h] = await evaluate('[innerWidth, innerHeight]');
    if (w === 1200 && h === 900) break;
    const { bounds } = await rpc('Browser.getWindowBounds', { windowId });
    await rpc('Browser.setWindowBounds', {
      windowId, bounds: { windowState: 'normal', width: bounds.width + 1200 - w, height: bounds.height + 900 - h },
    });
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(JSON.stringify(await evaluate('({ innerWidth, innerHeight, devicePixelRatio })')));
}
socket.close();
process.exit(0);
