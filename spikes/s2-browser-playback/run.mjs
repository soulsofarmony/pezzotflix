// S2 (throwaway): drive real installed browsers through auto.html and collect evidence.
// node spikes/s2-browser-playback/run.mjs [--browsers=msedge,chrome,firefox] [--passes=2] [--only=h2,s2] [--headless=msedge]
// Needs: out/node with playwright-core (no bundled browsers), out/media + out/vendor from prepare*.sh.
// Output: out/auto/<tag>-{report,players}.json, <tag>-gpu.txt
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'out', 'node', 'package.json'));
const { chromium } = require('playwright-core');
const OUT = path.join(HERE, 'out', 'auto');
const REPORTS = path.join(HERE, 'out', 'reports');
fs.mkdirSync(OUT, { recursive: true });

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BROWSERS = arg('browsers', 'msedge,chrome,firefox').split(',').filter(Boolean);
const HEADLESS = arg('headless', '').split(',').filter(Boolean);
const PASSES = arg('passes', '2');
const ONLY = arg('only', '');
const PORT = 8765;
const URL_BASE = `http://localhost:${PORT}/auto.html?passes=${PASSES}${ONLY ? '&only=' + ONLY : ''}`;
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const srv = spawn('python', ['-I', path.join(HERE, 'server.py')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://localhost:${PORT}/auto.html`); if (r.ok) return srv; } catch (_) {} await sleep(200); }
  throw new Error('server did not start');
}

// innerText does not cross shadow roots (chrome://gpu uses them): walk the tree.
const GPU_WALK = () => {
  const walk = n => { let s = ''; if (n.shadowRoot) s += walk(n.shadowRoot);
    for (const c of n.childNodes) { if (c.nodeType === 3) s += c.textContent.replace(/\s+/g, ' ');
      else if (c.nodeType === 1 && !/^(STYLE|SCRIPT)$/.test(c.tagName)) { s += walk(c); if (/^(DIV|P|TR|H\d|LI|BR|SPAN)$/.test(c.tagName) && c.children.length === 0) s += '\n'; else if (/^(TR|H\d|LI|DIV)$/.test(c.tagName)) s += '\n'; else if (c.tagName === 'TD') s += '\t'; } }
    return s; };
  return walk(document.body).replace(/\n\s*\n+/g, '\n');
};

async function runChromium(channel, headless) {
  const tag = channel + (headless ? '-headless' : '');
  console.log(`== ${tag}`);
  const browser = await chromium.launch({ channel, headless, args: [
    '--autoplay-policy=no-user-gesture-required', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const gp = await ctx.newPage();
  try { await gp.goto('chrome://gpu'); await gp.waitForTimeout(4000); fs.writeFileSync(path.join(OUT, `${tag}-gpu.txt`), await gp.evaluate(GPU_WALK)); }
  catch (e) { fs.writeFileSync(path.join(OUT, `${tag}-gpu.txt`), 'error: ' + e.message); }
  await gp.close();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  let current = 'init'; const players = {};
  const P = id => (players[id] ||= { test: current, props: {}, events: [], errors: [], messages: [] });
  cdp.on('Media.playersCreated', e => { for (const x of e.players) P(typeof x === 'string' ? x : x.playerId); });
  cdp.on('Media.playerPropertiesChanged', e => { const p = P(e.playerId); for (const x of e.properties) p.props[x.name] = x.value; });
  cdp.on('Media.playerEventsAdded', e => { const p = P(e.playerId); for (const x of e.events) if (p.events.length < 40) p.events.push(x.value); });
  cdp.on('Media.playerErrorsRaised', e => P(e.playerId).errors.push(...e.errors.map(x => JSON.stringify(x).slice(0, 400))));
  cdp.on('Media.playerMessagesLogged', e => { const p = P(e.playerId); for (const m of e.messages) if (m.level !== 'debug' && p.messages.length < 40) p.messages.push(`${m.level}: ${m.message}`.slice(0, 400)); });
  await cdp.send('Media.enable');
  await page.exposeFunction('__mark', id => { current = id; });
  page.on('pageerror', e => console.log(tag, 'PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log(tag, 'CONSOLE-ERR', m.text().slice(0, 300)); });
  page.on('console', m => { if (m.text().startsWith('[s2]')) console.log(tag, m.text().slice(0, 300)); });
  await page.goto(`${URL_BASE}&tag=${headless ? 'headless' : ''}`);
  const rep = await page.evaluate(() => window.runAll());
  fs.writeFileSync(path.join(OUT, `${tag}-report.json`), JSON.stringify(rep, null, 1));
  // keep only useful player properties
  const KEEP = /Decoder|Platform|Renderer|Codec|Resolution|Container|Frame|Duration|Bitrate|Audio|Video|Encrypt|kIs|Hdr|Color/i;
  for (const p of Object.values(players)) p.props = Object.fromEntries(Object.entries(p.props).filter(([k]) => KEEP.test(k)));
  fs.writeFileSync(path.join(OUT, `${tag}-players.json`), JSON.stringify(players, null, 1));
  await browser.close();
}

async function runFirefox() {
  if (!fs.existsSync(FIREFOX)) { console.log('Firefox not installed'); return; }
  console.log('== firefox');
  const prof = path.join(HERE, 'out', 'profiles', 'firefox');
  fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'user.js'), [
    'user_pref("media.autoplay.default", 0);', 'user_pref("media.autoplay.blocking_policy", 0);',
    'user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);', 'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("app.update.auto", false);', 'user_pref("startup.homepage_welcome_url", "");',
  ].join('\n'));
  fs.mkdirSync(REPORTS, { recursive: true });
  const before = new Set(fs.readdirSync(REPORTS));
  const ff = spawn(FIREFOX, ['-no-remote', '-new-instance', '-profile', prof, `${URL_BASE}&auto=1`], { stdio: 'ignore' });
  let found = null;
  for (let i = 0; i < 450 && !found; i++) { await sleep(2000); found = fs.readdirSync(REPORTS).find(f => !before.has(f) && f.startsWith('firefox')); }
  try { execSync(`taskkill /PID ${ff.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  // the launcher pid hands off to a new main process: kill everything started with our profile
  try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='firefox.exe'\\" | Where-Object { $_.CommandLine -like '*out\\profiles\\firefox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' }); } catch (_) {}
  if (found) { fs.copyFileSync(path.join(REPORTS, found), path.join(OUT, 'firefox-report.json')); console.log('firefox report', found); }
  else console.log('firefox: no report (timeout)');
}

const srv = await startServer();
try {
  for (const b of BROWSERS) {
    try { if (b === 'firefox') await runFirefox(); else await runChromium(b, false); }
    catch (e) { console.log(`${b} failed: ${e.stack}`); }
  }
  for (const b of HEADLESS) { try { await runChromium(b, true); } catch (e) { console.log(`${b} headless failed: ${e.stack}`); } }
} finally { srv.kill(); }
