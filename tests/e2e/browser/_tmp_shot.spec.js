const {test, expect} = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architect 1';
const PANE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'pane_claude_done.txt'), 'utf8');

test('shot', async ({page}) => {
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await page.evaluate(async () => {
    const mine = paneOf(activePane), other = agents.find(a => a.label === 'scratch');
    const mineKey = convMemberKey(mine), otherKey = convMemberKey(other);
    pairs = [{id: 'p1', members: [recentFingerprint(mine), recentFingerprint(other)]}];
    await convPut({key: otherKey, label: 'scratch', first: 1, touched: 2, spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'said by my partner', seen: 1, label: 'scratch'}]});
    await convPut({key: 'm3', label: 'third', first: 1, touched: 2, spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'said by a stranger', seen: 2, label: 'third'}]});
    saveConvIndex([{id: 'c1', name: 'three of us', created: Date.now(), members: [
      {key: mineKey, added: 1, label: 'Architect 1'},
      {key: otherKey, added: 1, label: 'scratch'},
      {key: 'm3', added: 1, label: 'third'}]}]);
  });
  await page.evaluate(async text => {
    paneOf(activePane).status = 'done';
    setPaneText(text);
    await recordPane(activePane, paneRows);
  }, PANE);
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#termMenuBtn').click();
  await page.locator('#termMenu').screenshot({path: process.env.SHOT || '/tmp/menu.png'});
});
