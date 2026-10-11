// Synthetic sculpting for gate 2 run C, over CDP real input events.
//   node sculpt.mjs <urlSubstring> <seconds>
// One stroke every 100 ms at a random point in the middle half of a 1200x900
// viewport: move, press, drag a few px, release ~60 ms later. Strokes come in
// raise/lower pairs at one spot (left, then shift+left) so the world stays near
// its starting shape. Counts WebSocket frames each way and prints a line a minute.
const PORT = process.env.CDP_PORT ?? '9222';
const [match, secondsArg] = process.argv.slice(2);
const DURATION_MS = Number(secondsArg) * 1000;
const [W, H] = [1200, 900];
const STROKE_EVERY_MS = 100;
const HOLD_MS = 60;
const SHIFT = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let nextId = 1;
const pending = new Map();
const counts = { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0, strokes: 0 };
const received = new Map();
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject, method } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    return;
  }
  if (m.method === 'Network.webSocketFrameSent') {
    counts.sent++; counts.sentBytes += m.params.response.payloadData.length;
  }
  if (m.method === 'Network.webSocketFrameReceived') {
    counts.received++; counts.receivedBytes += m.params.response.payloadData.length;
    // Tally received message types when the payload is text JSON; binary is base64.
    const data = m.params.response.payloadData;
    const type = m.params.response.opcode === 1 ? (/"type"\s*:\s*"([^"]+)"/.exec(data)?.[1] ?? 'text') : 'binary';
    received.set(type, (received.get(type) ?? 0) + 1);
  }
});
const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timeout`)); }, 30_000);
  pending.set(id, {
    method, reject,
    resolve: (v) => { clearTimeout(timer); resolve(v); },
  });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetInfos } = await rpc('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page' && t.url.includes(match));
if (!page) throw new Error(`no page matching ${match}`);
const { sessionId } = await rpc('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await rpc('Network.enable', {}, sessionId);

const mouse = (type, x, y, modifiers, extra = {}) => rpc('Input.dispatchMouseEvent', {
  type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  pointerType: 'mouse', ...extra,
}, sessionId);

const started = Date.now();
let nextMinute = started + 60_000;
let spot = null;
for (let i = 0; Date.now() - started < DURATION_MS; i++) {
  const due = started + i * STROKE_EVERY_MS;
  if (due > Date.now()) await sleep(due - Date.now());
  const raise = i % 2 === 0;
  if (raise) spot = { x: Math.round(W / 4 + Math.random() * W / 2), y: Math.round(H / 4 + Math.random() * H / 2) };
  const modifiers = raise ? 0 : SHIFT;
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, modifiers, buttons: 0 }, sessionId);
  await mouse('mousePressed', spot.x, spot.y, modifiers);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + 3, y: spot.y + 2, modifiers, button: 'left', buttons: 1 }, sessionId);
  await sleep(HOLD_MS);
  await mouse('mouseReleased', spot.x + 3, spot.y + 2, modifiers);
  counts.strokes++;
  if (Date.now() >= nextMinute) {
    nextMinute += 60_000;
    console.log(`${Math.round((Date.now() - started) / 1000)} s  ${JSON.stringify(counts)}`);
  }
}
console.log(`done ${Math.round((Date.now() - started) / 1000)} s  ${JSON.stringify(counts)}`);
console.log(`received types ${JSON.stringify(Object.fromEntries(received))}`);
socket.close();
process.exit(0);
