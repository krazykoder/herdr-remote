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

test('the relay’s gate reaches the button that appoints one', async ({page}) => {
  await openConv(page);
  // The gate is the ⚖ over the thread, not a strip: a conversation nobody is arbitrating draws
  // nothing above its messages.
  await expect(page.locator('#convArbitrator')).toBeVisible();
  await expect(page.locator('#arbStrip')).toBeEmpty();
});

test('starting names two pane ids, an arbitrator and a scope — and nothing else', async ({page}) => {
  await openConv(page);
  await captureSends(page);
  await page.locator('#convArbitrator').click();
  await page.locator('#arbScope').fill('Get the footer reviewed, then stop.');
  await page.locator('#arbWho').selectOption({label: ARBITER});
  await page.locator('#arbSetupBody .arb-btn.go').click();

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

test('the arbitrator may be a member of the room it is deciding about', async ({page}) => {
  // The picker used to offer only panes outside the conversation and only ones that were idle at
  // that moment. Which pane is well placed to referee is the person's judgement; what is refused
  // is one agent in two slots, and that is refused where it is law — the relay's _enrol.
  await openConv(page);
  await captureSends(page);
  await page.locator('#convArbitrator').click();
  const options = await page.locator('#arbWho option').allTextContents();
  expect(options).toContain(ARBITER);
  expect(options).toContain(MEMBERS[0]);

  await page.locator('#arbScope').fill('Get the footer reviewed, then stop.');
  await page.locator('#arbWho').selectOption({label: MEMBERS[0]});
  await page.locator('#arbSetupBody .arb-btn.go').click();
  await expect(page.locator('#toast')).toContainText('cannot arbitrate itself');
  expect(await sent(page)).toHaveLength(0);
});

test('a role badge writes a phrase, and the phrase is what the relay is asked for', async ({page}) => {
  await openConv(page);
  await captureSends(page);
  await page.locator('#convArbitrator').click();
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
  await page.locator('#arbSetupBody .arb-btn.go').click();

  const msgs = await sent(page);
  expect(msgs[0].members).toEqual([{pane_id: 'w1:p1', role: 'review only, no code writing'},
                                   {pane_id: 'w8:p1', role: 'writes the code'}]);
  await expect(page.locator('#toast')).toContainText('send_unconfirmed', {timeout: 20000});
});

test('⚖ over a conversation with no arbitrator opens the dialog that appoints one', async ({page}) => {
  await openConv(page);
  const btn = page.locator('#convArbitrator');
  await expect(btn).toBeVisible();
  await expect(btn).not.toHaveClass(/live/);
  await btn.click();
  await expect(page.locator('#arbScope')).toBeVisible();
  // Three sections, because there are three decisions: who decides, and the two it decides
  // between.
  await expect(page.locator('#arbSetupBody .arb-part-lede')).toHaveText(
    ['Arbitrator', 'Agent 1', 'Agent 2']);
  // A dialog, so a tap beside it is the way out — and nothing it was over moved to make room.
  await page.mouse.click(5, 5);
  await expect(page.locator('#arbModal')).toBeHidden();
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
  await page.locator('#convArbitrator').click();
  await page.locator('#arbScope').fill('Half a sen');
  // Two poll intervals. The view redraws on every snapshot, and the dialog is drawn once when it
  // opens precisely so this element is not rebuilt under the person typing into it.
  await page.waitForTimeout(4500);
  await expect(page.locator('#arbScope')).toHaveValue('Half a sen');
});

test('a slot starts its own agent, and the dialog is still there when it arrives', async ({page}) => {
  await openConv(page);
  await captureSends(page);
  // What the relay is willing to start, and the Projects to start into. The fake herdr's board
  // never grows, so the pane the start "produces" is one that is already live.
  const spare = await page.evaluate(() => {
    projects = [{id: 'p1', label: 'herdr-remote', host: 'local'}];
    startOptions = {type: 'start_options', agents: ['claude', 'codex'], roles: ['architect']};
    for (const a of agents) { a.project_id = 'p1'; a.workspace_id = 'w1'; }
    return agents.find(a => a.label === 'amp').pane_id;
  });
  await page.locator('#convArbitrator').click();
  await page.locator('#arbScope').fill('Half a sen');
  // The New agent dialog, over the arbitration one rather than instead of it.
  await page.locator('#arbSetupBody .arb-part', {hasText: 'Agent 2'})
    .getByRole('button', {name: '+ New'}).click();
  await expect(page.locator('#newAgentModal')).toBeVisible();
  await page.locator('#newAgentSubmit').click();
  await expect(page.locator('#newAgentModal')).toBeHidden();
  await expect(page.locator('#arbModal')).toBeVisible();

  await page.evaluate(id => {
    handleMessage({type: 'command_result', command: 'start_agent', ok: true, pane_id: id});
    openPendingStart();
  }, spare);

  // Chosen in the slot that asked for it, with everything already answered kept — and the person
  // is still in the dialog rather than in the new pane's terminal.
  await expect(page.locator('#arbSecond')).toHaveValue(spare);
  await expect(page.locator('#arbScope')).toHaveValue('Half a sen');
  await expect(page.locator('#terminalView')).toBeHidden();
  expect(await page.evaluate(() => loadConvIndex()[0].members.length)).toBe(3);
});

test('a running session shows what it is doing and how to stop it', async ({page}) => {
  await openConv(page);
  await broadcast(page, session({last_decision: {
    sequence: 1, gate: 'review', to: 'member-2', why: 'Ready for an independent check.',
    ambiguity: 'low', at: Date.now()}}));
  const strip = page.locator('#arbStrip .arb-strip');
  await expect(strip).toContainText('Arbitrating');
  // Where the session is, not what was last said — the sentence lives in the Log, and what the
  // state means lives in the sheet a tap on the tray opens.
  await expect(strip).not.toContainText('Ready for an independent check.');
  await expect(strip).toContainText('7 steps · 44 min');
  // Three rows and no more: a row of controls that must not wrap, the state, and the budget. The
  // tray hangs over a thread being read, and every pixel of it is a pixel of that thread.
  expect(await page.locator('#arbStrip .arb-bar')
    .evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(48);
  expect(await strip.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(90);
  // Right-aligned with the row of buttons above it, which is what makes the two one stack — and
  // exactly as wide as its own row of buttons, so a long pause reason wraps rather than reshaping
  // the tray every time the session moves.
  const box = await page.evaluate(() => {
    const at = sel => document.querySelector(sel).getBoundingClientRect();
    return {floatRight: at('#convView .conv-view-top .hang-float').right,
            right: at('#arbStrip .arb-strip').right,
            width: at('#arbStrip .arb-strip').width,
            bar: at('#arbStrip .arb-bar').width};
  });
  expect(Math.abs(box.floatRight - box.right)).toBeLessThan(1.5);
  // The tray's own padding and border, and nothing else.
  expect(box.width - box.bar).toBeLessThan(13);

  await captureSends(page);
  await strip.getByRole('button', {name: 'Pause'}).click();
  expect(await sent(page)).toEqual([{type: 'arb_pause', session: 's-20260817-1103'}]);
});

test('a paused session says why, and offers the way back', async ({page}) => {
  await openConv(page);
  await broadcast(page, session({state: 'paused', pause_reason: 'budget_steps'}));
  const strip = page.locator('#arbStrip .arb-strip');
  await expect(strip).toContainText('Paused · out of steps');
  await captureSends(page);
  await strip.getByRole('button', {name: 'Resume', exact: true}).click();
  expect(await sent(page)).toEqual([{type: 'arb_resume', session: 's-20260817-1103'}]);

  // And the other way back, for a session whose members are all sitting idle: arming alone would
  // wait for a turn that is never going to end.
  await page.evaluate(() => { window.__sent = []; });
  await strip.getByRole('button', {name: 'Ask the arbitrator now'}).click();
  expect(await sent(page)).toEqual([
    {type: 'arb_resume', session: 's-20260817-1103', kick: true}]);
});

test('a running session is edited through the form that appointed it', async ({page}) => {
  await openConv(page);
  await broadcast(page, session());
  await captureSends(page);
  // The roster on the strip is the way in — the same dialog, opened on the answers it already has.
  await page.locator('#arbStrip').getByRole('button', {name: 'Edit'}).click();
  await expect(page.locator('#arbScope')).toHaveValue('Get the footer reviewed.');
  await expect(page.locator('#arbWho')).toHaveValue('w1:p2');
  await expect(page.locator('#arbSetupBody')).not.toContainText('On start');

  await page.locator('#arbScope').fill('Get the footer reviewed, then stop.');
  await page.locator('#arbSetupBody .arb-btn.go').click();
  await expect(page.locator('#arbModal')).toBeHidden();
  // Only the scope: the roster and the clocks were not touched, and naming them would re-announce
  // a change nobody made.
  expect(await sent(page)).toEqual([{type: 'arb_edit', session: 's-20260817-1103',
                                     scope: 'Get the footer reviewed, then stop.'}]);
});

test('the path is drawn in the thread, and the whole of it is in the log', async ({page}) => {
  await openConv(page);
  await broadcast(page, session());
  // The relay's answer to `arb_detail`, fed to the page's own handler: what this asserts is the
  // half that is the page's — the steps landing among the messages, and the sheet holding all of
  // them. `tests/test_arbitration.py` is what holds the relay to writing them.
  await page.evaluate(() => handleMessage({
    type: 'arb_detail', session: 's-20260817-1103',
    decisions: [{sequence: 1, at: 1000, valid: true, gate: 'review', to: 'member-2',
                 why: 'Ready for a look.', send: {pane_id: 'w8:p1'}}],
    events: [{kind: 'trigger', detail: 'member-1 ended a turn (turn_end)', at: 900, sequence: 0},
             {kind: 'asked', detail: 'w1:p2 for decision #1 (turn_end), 392 chars', at: 910,
              sequence: 1},
             {kind: 'sent', detail: 'review to scratch (w8:p1), 180 chars', at: 1010, sequence: 1},
             {kind: 'error', detail: 'reading the drop box: OSError(21)', at: 1100, sequence: 1}],
  }));

  const thread = page.locator('#convViewThread');
  await expect(thread).toContainText('trigger');
  await expect(thread).toContainText('review to scratch (w8:p1), 180 chars');
  // The step that went wrong is the one that has to be found rather than read past.
  await expect(thread.locator('.conv-commit.warn', {hasText: 'OSError'})).toBeVisible();

  await page.locator('#arbStrip').getByRole('button', {name: 'Log'}).click();
  const path = page.locator('#arbSheet .arb-path');
  await expect(path).toContainText('w1:p2 for decision #1');
  await expect(path).toContainText('reading the drop box');
});

test('ending is asked twice, and the strip goes with the session', async ({page}) => {
  await openConv(page);
  await broadcast(page, session());
  await captureSends(page);
  // Behind the Edit dialog rather than on the strip: over a scrolling thread, armed is one mistap
  // from a session that is gone for good.
  await page.locator('#arbStrip').getByRole('button', {name: 'Edit'}).click();
  const end = page.locator('#arbSetupBody').getByRole('button', {name: /End session/});
  await end.click();
  expect(await sent(page)).toEqual([]);          // the first tap only arms it
  await end.click();
  expect(await sent(page)).toEqual([{type: 'arb_cancel', session: 's-20260817-1103'}]);
  // And the dialog it was pressed in closes with it — a Save landing on a session that is ending
  // is the one thing worse than having the button there in the first place.
  await expect(page.locator('#arbModal')).toBeHidden();

  await broadcast(page, session({state: 'ended'}));
  await expect(page.locator('#arbStrip')).toBeEmpty();
});
