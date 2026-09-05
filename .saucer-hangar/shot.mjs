// Screenshots the embedded hangar: formation, each craft close-up, and the
// aluminium hull with the environment OFF against the sky backdrop (the A/B).
//   node shot.mjs
import { chromium } from '/home/shawn/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const here = new URL('.', import.meta.url).pathname;
const b = await chromium.launch({ executablePath:'/home/shawn/.cache/ms-playwright/chromium-1232/chrome-linux64/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{ width:1400, height:820 } });
p.on('console', m => { if (m.type()==='error') console.log('console:', m.text()); });
p.on('pageerror', e => console.log('pageerror:', e.message));
const shots = [
  ['hangar', ''], ['hangar-a', 'focus=a'], ['hangar-b', 'focus=b'], ['hangar-c', 'focus=c'],
  ['hangar-b-sky-env', 'focus=b&sky=1'], ['hangar-b-sky-noenv', 'focus=b&sky=1&env=0'],
];
for (const [name, query] of shots) {
  await p.goto(`file://${here}saucer-hangar.html${query ? `?${query}` : ''}`);
  await p.waitForTimeout(query ? 6000 : 9000);
  await p.screenshot({ path:`${here}${name}.png` });
}
await b.close();
