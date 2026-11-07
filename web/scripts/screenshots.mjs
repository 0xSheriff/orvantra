// Dev helper: screenshots of every page at 1440x900 into design/impl-*.png (run with the dev server up).
//   node scripts/screenshots.mjs [baseUrl]
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:3100';
const out = resolve(import.meta.dirname, '../../design');
const pages = [
  ['review', '/review'],
  ['list', '/invoices'],
  ['vendors', '/vendors'],
  ['rules', '/rules'],
  ['activity', '/activity'],
];
const extra = process.argv.slice(3); // more "name=/path" pairs
for (const e of extra) {
  const [n, p] = e.split('=');
  pages.push([n, p]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
for (const [name, path] of pages) {
  const res = await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const file = `${out}/impl-${name}.png`;
  await page.screenshot({ path: file });
  console.log(`${res?.status()} ${path} -> ${file}`);
}
await browser.close();
