const {test, expect} = require('/Users/towshif/code/python/herdr-remote/.claude/worktrees/fix+keyboard-inset/tests/e2e/browser/fixtures.js');

test.beforeEach(async ({page}) => { await page.goto('/'); });

test('repro: recorded split', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await expect.poll(() => page.evaluate(() => agents.length)).toBeGreaterThan(0);
  const out = await page.evaluate(async () => {
    const liveKey = convMemberKey(agents[0]);
    const deadKey = JSON.stringify(['local', 'w4:p9', 'claude', '/work/old']);
    await convPut({key: liveKey, label: 'live one', entries: [{who: 'agent', text: 'x'.repeat(200)}]});
    await convPut({key: deadKey, label: 'dead one', entries: [{who: 'agent', text: 'y'.repeat(500)}]});
    // A transcript from a session nobody filed — exactly what the Add-pane picker lists under
    // "Recorded".
    await convPut({key: JSON.stringify(['local', 'w7:p7', 'codex', '/work/orphan']),
      label: 'orphan', entries: [{who: 'agent', text: 'z'.repeat(4000)}]});
    saveConvIndex([{id: 'cX', name: 'Mixed', members: [
      {key: liveKey, added: 1, label: 'live one'},
    ]}]);
    const rows = await fetchConvAnalytics();
    return {rows, unfiled: convAnalyticsUnfiled,
      inDb: (await convAll()).reduce((n, r) => n + JSON.stringify(r).length, 0)};
  });
  console.log(JSON.stringify(out, null, 1));
  expect(out.unfiled.count).toBe(2);
  expect(out.rows[0].totalBytes - out.rows[0].indexBytes + out.unfiled.bytes).toBe(out.inDb);
});
