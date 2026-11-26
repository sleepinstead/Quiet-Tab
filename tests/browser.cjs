const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const extension = path.join(__dirname, '../ext');
const ready = page => page.waitForSelector('body[data-ready="1"]');
const readStorage = (page, key) => page.evaluate(key => chrome.storage.local.get(key), key);

test('new-tab features, concurrent changes, image backup, restart and reset', { timeout: 120000 }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-tab-browser-'));
  const errors = [];
  let context;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true, reducedMotion: 'reduce', timeout: 20000,
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
    });
    context.setDefaultTimeout(6000);
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
    });
  }
  async function tab() {
    const page = await context.newPage();
    await page.goto('chrome://newtab/');
    await ready(page);
    return page;
  }
  async function note(page, text) {
    await page.locator('#addBtn').click();
    await page.locator('#addNote').click();
    await page.locator('[contenteditable]:focus').fill(text);
    await page.keyboard.press('Tab');
  }
  t.after(async () => {
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  });

  await launch();
  let page = await tab();
  await page.click('#tourNext');
  await page.click('#tourSkip');
  await note(page, 'Remember the release');
  await page.locator('[contenteditable]').fill('Remember the release immediately');
  await page.goto('about:blank');
  await page.goto('chrome://newtab/');
  await ready(page);
  assert.equal(await page.locator('[contenteditable]').textContent(), 'Remember the release immediately');
  await page.click('#addBtn');
  await page.click('#addTodo');
  await page.fill('.td-title', 'Release');
  await page.getByPlaceholder('Add a task').fill('Check the build');
  await page.getByPlaceholder('Add a task').press('Enter');
  await page.click('.td-check');
  await page.click('#addBtn');
  await page.click('#addLink');
  await page.fill('#dUrl', 'example.org');
  await page.fill('#dName', 'Example');
  await page.click('#dlgSave');
  assert.equal(await page.getByRole('link', { name: 'Example', exact: true }).getAttribute('href'), 'https://example.org/');

  await page.setInputFiles('#pinFile', path.join(extension, 'icons/128.png'));
  await page.waitForFunction(() => document.querySelector('#board .img img')?.naturalWidth > 0);
  await page.click('#openSettings');
  await page.setInputFiles('#bgFile', path.join(extension, 'icons/48.png'));
  await page.waitForSelector('#bgimg.on', { state: 'attached' });
  await page.click('#mode [data-v=dark]');
  await page.locator('label[for=showClock], label:has(#showClock)').first().click();
  await page.click('#closeSettings');
  const other = await tab();
  await other.waitForSelector('body.no-clock', { state: 'attached' });
  // Exercise two independent page editors writing the same stored board array.
  await Promise.all([note(page, 'Editor one'), note(other, 'Editor two')]);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.storage.onChanged.removeListener(check);
      reject(new Error('Both edits did not reach local storage'));
    }, 6000);
    async function check() {
      const { board } = await chrome.storage.local.get('board');
      if (['Editor one', 'Editor two'].every(text => board?.some(item => item.text === text))) {
        clearTimeout(timeout);
        chrome.storage.onChanged.removeListener(check);
        resolve();
      }
    }
    chrome.storage.onChanged.addListener(check);
    check();
  }));
  await other.close();
  await page.click('#openSettings');
  const downloading = page.waitForEvent('download');
  await page.click('#exportBtn');
  const download = await downloading;
  const backup = await fs.readFile(await download.path());
  const parsed = JSON.parse(backup);
  assert.equal(parsed.settings.board.length, 5, JSON.stringify(parsed.settings.board));
  assert.equal(Object.keys(parsed.blobs).length, 2);

  const invalid = structuredClone(parsed);
  delete invalid.blobs.bg;
  await page.setInputFiles('#importFile', { name: 'incomplete.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Invalid'));
  assert.equal((await readStorage(page, 'board')).board.length, 5);

  async function replace(action) {
    page.once('dialog', dialog => dialog.accept());
    await Promise.all([page.waitForEvent('domcontentloaded'), action()]);
    await ready(page);
  }
  await replace(() => page.setInputFiles('#importFile', { name: 'backup.json', mimeType: 'application/json', buffer: backup }));
  await page.waitForFunction(() => document.querySelector('#board .img img')?.naturalWidth > 0);
  await context.close();
  await launch();
  page = await tab();
  await page.waitForFunction(() => document.querySelector('#board .img img')?.naturalWidth > 0);
  assert.equal(await page.locator('.td-check').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#board .item').count(), 5);
  await page.waitForSelector('#bgimg.on', { state: 'attached' });
  await page.setViewportSize({ width: 360, height: 540 });
  await page.click('#openSettings');
  await replace(() => page.click('#resetAll'));
  await page.click('#tourSkip');
  assert.equal(await page.locator('#board .item').count(), 0);
  assert.equal(await page.locator('#links a').count(), 4);
  assert.deepEqual(errors, []);
});
