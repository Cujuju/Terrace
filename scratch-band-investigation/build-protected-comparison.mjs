import { readFile, writeFile } from 'node:fs/promises';

const compressed = await readFile(new URL('protected-data.json.gz', import.meta.url));
const template = await readFile(new URL('comparison-template.html', import.meta.url), 'utf8');
const fragment = template.replace('__COMPRESSED_DATA__', compressed.toString('base64'))
  .replace('__REVIEW_CONFIG__', JSON.stringify({ prototype: true }));
// A standalone output has no host theme, so it supplies the four colors the template reads.
const STANDALONE_THEME = '<style>:root{--background:#f6f4ef;--foreground:#1f2328;--muted:#7d8590;--orange:#c8742c}</style>\n';
const standalone = process.argv[2];
const output = standalone ?? 'C:/Users/<user>/.codex/visualizations/2026/09/22/01a0c683-853c-7e52-b09d-8c448eb2792b/terrace-protected-filter.html';
const page = standalone ? STANDALONE_THEME + fragment : fragment;
await writeFile(output, page);
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(page) }));
