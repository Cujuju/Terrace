// Screenshots the embedded hangar: the formation, then each craft in close-up.
//   node shot.mjs
import { chromium } from '/home/shawn/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const here = new URL('.', import.meta.url).pathname;
const b = await chromium.launch({ executablePath:'/home/shawn/.cache/ms-playwright/chromium-1232/chrome-linux64/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{ width:1400, height:820 } });
p.on('console', m => { if (m.type()==='error') console.log('console:', m.text()); });
p.on('pageerror', e => console.log('pageerror:', e.message));
for (const focus of ['', 'a', 'b', 'c']) {
  await p.goto(`file://${here}saucer-hangar.html${focus ? `?focus=${focus}` : ''}`);
  await p.waitForTimeout(focus ? 6000 : 9000);
  await p.screenshot({ path:`${here}hangar${focus ? `-${focus}` : ''}.png` });
}
await b.close();
