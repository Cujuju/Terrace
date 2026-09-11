// Close every page target except the one whose url contains argv[2].
const keep = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
for (const t of list.filter((t) => t.type === 'page' && !t.url.includes(keep))) {
  await fetch(`http://127.0.0.1:9222/json/close/${t.id}`);
  console.log('closed ' + (t.url || '(empty)'));
}
