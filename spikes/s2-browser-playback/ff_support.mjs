// S2 (throwaway): dump Firefox about:support media/codec section via WebDriver BiDi (puppeteer-core).
// node spikes/s2-browser-playback/ff_support.mjs  -> out/auto/firefox-about-support.txt
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'out', 'node', 'package.json'));
const puppeteer = require('puppeteer-core');
const prof = path.join(HERE, 'out', 'profiles', 'firefox-support');
fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof, { recursive: true });
const browser = await puppeteer.launch({ browser: 'firefox', headless: false, executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe', userDataDir: prof, args: ['about:support'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
try {
  // BiDi refuses to navigate to about: pages, so open it from the command line and attach to the tab
  await new Promise(r => setTimeout(r, 6000));
  const pages = await browser.pages();
  console.log('pages', pages.map(p => p.url()));
  const page = pages.find(p => p.url().startsWith('about:support')) || pages[0];
  let txt;
  try { txt = await page.evaluate(() => document.body.innerText); } catch (e) { txt = 'evaluate failed: ' + e.message; }
  fs.writeFileSync(path.join(HERE, 'out', 'auto', 'firefox-about-support.txt'), txt);
  await page.screenshot({ path: path.join(HERE, 'out', 'auto', 'firefox-about-support.png'), fullPage: true }).catch(e => console.log('screenshot', e.message));
  console.log('chars', txt.length);
} finally { await browser.close(); }
