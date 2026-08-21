// The session strip, in a real browser.
//
// tests/test_arbitration_ui.js covers what is drawn for every state. What it cannot see is the
// half that is the page's: the relay's gate message reaching a handler, the strip's element being
// where the markup says it is, and a form whose value survives the poll that redraws the view
// around it. That last one is the bug this arrangement exists to prevent — a scope textarea
// rebuilt three times a minute is a sentence nobody can finish typing.
//
//   npx playwright test tests/e2e/browser/arbitration.spec.js
const {test, expect} = require('./fixtures');

// Serial, because one test here really does start a session on the shared worker relay. It ends
// on its own — the fake herdr reports a fixed board, so the pane never leaves `idle` and the
// starter prompt is never confirmed — but between the INSERT and the end there is a window in
// which every other client on that relay is correctly told a session is running, which is a strip
// the tests below are not expecting. Ordering them is cheaper than teaching each to tolerate it.
test.describe.configure({mode: 'serial'});

// Two live panes for the conversation and a third outside it for the arbitrator, which is the one
// shape v1 runs. All three are agents the fake herdr reports on this host. The arbitrator is the
// idle one on purpose: a working pane is not offered as one, because the starter prompt is the
// only thing that tells it what it is and a busy composer is where that goes missing. A working
// *member* is ordinary — nothing is written to it until a decision names it.
const MEMBERS = ['Architect 1', 'scratch'];
const ARBITER = 'amp';

// A conversation over two live panes, opened. Conversations are the browser's own — the relay
// knows nothing about them until arb_start names one.
const openConv = async page => {
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  await page.evaluate(names => {
    const keys = names.map(n => convMemberKey(agents.find(a => a.label === n)));
    saveConvIndex([{
      id: 'c1', name: 'footer change', created: Date.now(),
      members: keys.map((k, i) => ({key: k, added: Date.now(), label: names[i]})),
    }]);
    openConversation('c1');
  }, MEMBERS);
  await expect(page.locator('#convViewTitle')).toHaveText('footer change');
};

// What this page put on the wire, without the relay's answer in the way: starting a session for
// real needs an arbitrator pane that moves when it is written to, and the fake herdr this suite
// shares reports a fixed board.
const captureSends = page => page.evaluate(() => {
  window.__sent = [];
  const real = ws.send.bind(ws);
  ws.send = data => { try { window.__sent.push(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
});

const sent = page => page.evaluate(() => window.__sent.filter(m => m.type.startsWith('arb_')));

// A session as the relay broadcasts it, fed to the page's own handler. The shape is the relay's,
// and it is `tests/e2e/e2e_arbitration.py` that holds the real relay to it — a failed start like
// the one above never broadcasts at all, so this suite cannot be the thing that checks it.
const session = (over = {}) => Object.assign({
  id: 's-20260817-1103', state: 'active', pause_reason: null, conversation: 'c1',
  scope: 'Get the footer reviewed.',
  members: [{id: 'member-1', label: 'Architect 1', pane_id: 'w1:p1', status: 'idle'},
            {id: 'member-2', label: 'scratch', pane_id: 'w8:p1', status: 'working'}],
  arbitrator: {pane_id: 'w1:p2', status: 'idle'},
  budget: {steps_left: 7, consecutive_left: 3, minutes_left: 44},
  last_decision: null,
}, over);

const broadcast = (page, s) =>
  page.evaluate(s => handleMessage({type: 'arb_session', session: s}), s);

test('the relay’s gate reaches the strip, and the strip is where the thread starts', async ({page}) => {
  await openConv(page);
  await expect(page.locator('#arbStrip button')).toHaveText('⚖ Arbitrate');
});

test('starting names two pane ids, an arbitrator and a scope — and nothing else', async ({page}) => {
  await openConv(page);
  await captureSends(page);
  await page.locator('#arbStrip button').click();
  await page.locator('#arbScope').fill('Get the footer reviewed, then stop.');
  await page.locator('#arbWho').selectOption({label: ARBITER});
  await page.locator('#arbStrip .arb-btn.go').click();

  const msgs = await sent(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].type).toBe('arb_start');
  expect(msgs[0].conversation).toBe('c1');
  expect(msgs[0].scope).toBe('Get the footer reviewed, then stop.');
  // A role each, empty because the form was left alone. Sent rather than omitted: an unroled
  // member is a fact about the roster.
  expect(msgs[0].members).toEqual([{pane_id: 'w1:p1', role: ''}, {pane_id: 'w8:p1', role: ''}]);
  expect(msgs[0].paused).toBe(false);   // briefed and armed, which is the default
  expect(msgs[0].arbitrator).toEqual({pane_id: 'w1:p2'});

  // Waited for, not merely allowed to happen: the fake herdr's board never moves, so the pane the
  // starter prompt went to stays `idle` and the send is never confirmed — and the relay ends the
  // session it had already inserted.
  // Leaving before that lands would hand the next test a relay reporting a session in flight.
  // Longer than the default 5s: the relay now watches an unconfirmed pane for the whole of
  // SUBMIT_TIMEOUT (8s) before saying so, which is the point of watching a pane rather than
  // counting presses. A 5s expectation was asserting the old give-up time.
  await expect(page.locator('#toast')).toContainText('send_unconfirmed', {timeout: 20000});
});

test('a role badge writes a phrase, and the phrase is what the relay is asked for', async ({page}) => {
  await openConv(page);
  await captureSends(page);
  await page.locator('#arbStrip button').click();
  await page.locator('#arbScope').fill('Get the footer reviewed, then stop.');
  await page.locator('#arbWho').selectOption({label: ARBITER});
  // Overlapping on purpose: two agents that can both review is what lets the arbitrator keep the
  // loop moving when one of them is working.
  // Tapped, not typed: the badge is the whole point of the row, and what it writes into the field
  // is the phrase the arbitrator is shown rather than the tag on the pill.
  await page.locator('#arbRoleFirstPills button[onclick*="review-only"]').click();
  await page.locator('#arbRoleFirstPills button[onclick*="no-code"]').click();
  await page.locator('#arbRoleSecond').fill('writes the code');
  await expect(page.locator('#arbRoleFirst')).toHaveValue('review only, no code writing');
  await page.locator('#arbStrip .arb-btn.go').click();

  const msgs = await sent(page);
  expect(msgs[0].members).toEqual([{pane_id: 'w1:p1', role: 'review only, no code writing'},
                                   {pane_id: 'w8:p1', role: 'writes the code'}]);
  await expect(page.locator('#toast')).toContainText('send_unconfirmed', {timeout: 20000});
});

test('⚖ over a conversation with no arbitrator opens the form that appoints one', async ({page}) => {
  await openConv(page);
  const btn = page.locator('#convArbitrator');
  await expect(btn).toBeVisible();
  await expect(btn).not.toHaveClass(/live/);
  await btn.click();
  // The strip's own form, opened from a button that stays reachable while the strip is scrolled
  // away — which is the whole reason it is in the floating row and not only on the strip.
  await expect(page.locator('#arbScope')).toBeVisible();
});

test('⚖ goes to the arbitrator’s own pane once this conversation has one', async ({page}) => {
  await openConv(page);
  await broadcast(page, session());
  const btn = page.locator('#convArbitrator');
  await expect(btn).toHaveClass(/live/);
  await btn.click();
  await expect(page.locator('#terminalView')).toBeVisible();
});

test('a half-written scope survives the poll that redraws the view around it', async ({page}) => {
  await openConv(page);
  await page.locator('#arbStrip button').click();
  await page.locator('#arbScope').fill('Half a sen');
  // Two poll intervals. The view redraws on every snapshot, and the strip is diffed on its own
  // precisely so this element is not rebuilt under the person typing into it.
  await page.waitForTimeout(4500);
  await expect(page.locator('#arbScope')).toHaveValue('Half a sen');
});

test('a running session shows what it is doing and how to stop it', async ({page}) => {
  await openConv(page);
  await broadcast(page, session({last_decision: {
    sequence: 1, gate: 'review', to: 'member-2', why: 'Ready for an independent check.',
    ambiguity: 'low', at: Date.now()}}));
  const strip = page.locator('#arbStrip .arb-strip');
  await expect(strip).toContainText('Arbitrating');
  await expect(strip).toContainText('review · scratch · Ready for an independent check.');
  await expect(strip).toContainText('7 steps · 44 min');

  await captureSends(page);
  await strip.getByRole('button', {name: 'Pause'}).click();
  expect(await sent(page)).toEqual([{type: 'arb_pause', session: 's-20260817-1103'}]);
});

test('a paused session says why, and offers the way back', async ({page}) => {
  await openConv(page);
  await broadcast(page, session({state: 'paused', pause_reason: 'budget_steps'}));
  const strip = page.locator('#arbStrip .arb-strip');
  await expect(strip).toContainText('Paused — budget steps');
  await captureSends(page);
  await strip.getByRole('button', {name: 'Resume'}).click();
  expect(await sent(page)).toEqual([{type: 'arb_resume', session: 's-20260817-1103'}]);
});

test('ending is asked twice, and the strip goes with the session', async ({page}) => {
  await openConv(page);
  await broadcast(page, session());
  await captureSends(page);
  const end = page.locator('#arbStrip').getByRole('button', {name: /End/});
  await end.click();
  expect(await sent(page)).toEqual([]);          // the first tap only arms it
  await end.click();
  expect(await sent(page)).toEqual([{type: 'arb_cancel', session: 's-20260817-1103'}]);

  await broadcast(page, session({state: 'ended'}));
  await expect(page.locator('#arbStrip .arb-strip')).toHaveText('⚖ Arbitrate');
});
