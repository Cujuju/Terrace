import { readFile, writeFile } from 'node:fs/promises';

const compressed = await readFile(new URL('protected-data.json.gz', import.meta.url));
const template = await readFile(new URL('comparison-template.html', import.meta.url), 'utf8');
const fragment = template.replace('__COMPRESSED_DATA__', compressed.toString('base64'))
  .replace('__REVIEW_CONFIG__', JSON.stringify({ prototype: true }));
const output = 'C:/Users/<user>/.codex/visualizations/2026/09/22/01a0c683-853c-7e52-b09d-8c448eb2792b/terrace-protected-filter.html';
await writeFile(output, fragment);
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(fragment) }));
