// Screenshot the running status page with a local Chromium-based browser (puppeteer-core, no download).
// usage: node scripts/screenshot.mjs [url] [out.png]   env BROWSER_PATH overrides the browser.
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:8787/';
const out = process.argv[3] ?? 'docs/status-page.png';
const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--disable-extensions'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('meta').textContent.includes('loading'));
  await page.screenshot({ path: out, fullPage: true });
  if (process.argv.includes('--mobile')) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.screenshot({ path: out.replace(/\.png$/, '-mobile.png'), fullPage: false });
  }
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
