// One arbitration session, start to end, driven from the page.
//
// tests/e2e/e2e_arbitration.py proves the loop against a websocket client, and the Playwright
// suite proves the strip against sessions it writes itself. Neither watches a person start a
// session and watch it decide: the browser suite's fake herdr reports a fixed board, so a turn
// there can never end. This one holds both halves at once — a real relay, a real browser, and a
// pane list that moves — which is the only arrangement where the strip is drawn from a decision
// that actually happened.
//
// Not part of the Playwright suite: it owns its own relay and rewrites its own board, and it costs
// ~30 seconds. Run it deliberately, after touching the strip or the loop under it:
//
//   node tests/e2e/e2e_arb_ui.js
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const PORT = Number(process.env.HERDR_E2E_UI_PORT || 8399);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-live-'));
const STATE = path.join(TMP, 'panes.json');
const DB = path.join(TMP, 'arb', 'arbitration.sqlite3');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PANES = [
  {pane_id: 'a1:p1', agent: 'claude', label: 'Architect 1', agent_status: 'idle', cwd: '/work/one', workspace_id: 'a1', tab_id: 'a1:t1'},
  {pane_id: 'a1:p2', agent: 'codex', label: 'Reviewer 1', agent_status: 'idle', cwd: '/work/two', workspace_id: 'a1', tab_id: 'a1:t2'},
  {pane_id: 'a1:p3', agent: 'claude', label: 'Arbitrator', agent_status: 'idle', cwd: '/work/arb', workspace_id: 'a1', tab_id: 'a1:t3'},
];
const write = p => fs.writeFileSync(STATE, JSON.stringify(p));
const setStatus = (id, s) => {
  const p = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  p.find(x => x.pane_id === id).agent_status = s;
  write(p);
};
const endTurn = async id => { setStatus(id, 'working'); await sleep(2.6e3); setStatus(id, 'done'); };

let fails = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  ${detail}`)); if (!ok) fails++; };

async function main() {
  fs.mkdirSync(path.join(TMP, 'logs'), {recursive: true});
  write(PANES);
  const env = {...process.env};
  for (const k of Object.keys(env)) if (k.startsWith('HERDR_') || k.startsWith('FAKE_')) delete env[k];
  Object.assign(env, {
    PATH: `${REPO}/tests/e2e/bin:${process.env.PATH}`,
    HERDR_BIN: `${REPO}/tests/e2e/bin/herdr`,
    FAKE_LOG: path.join(TMP, 'fake_herdr.log'),
    FAKE_PANES: STATE,
    HERDR_RELAY_PORT: String(PORT),
    HERDR_LAN_BIND: '127.0.0.1',
    HERDR_LAN_OPEN: '1',
    HERDR_STATE_DIR: path.join(TMP, 'logs'),
    HERDR_ARBITER_DB: DB,
    // Isolated like the arbiter DB, and for a sharper reason: without it the relay falls back to
    // PROJECT_ROOT/.herdr-remote/state.sqlite3 — the live install's — and this test's one-item
    // conversation index overwrites the user's. It has done exactly that.
    HERDR_STATE_DB: path.join(TMP, 'state.sqlite3'),
    HERDR_CONV_LOG: '1',
    // A turn that ends with nothing new on screen is held open for this long, and the fake's pane
    // read is a fixed frame — so every turn here takes the late path. Unset, the default 45s is
    // longer than the 30s this test waits for `Deciding`, and the trigger arrives after the
    // assertion has already failed. e2e_arbitration.py shortens it for the same reason.
    HERDR_LATE_TURN_MS: '1500',
    HERDR_ENABLE_WRITE_EXT: '1',
    HERDR_ENABLE_ARBITER: '1',
  });
  const out = fs.openSync(path.join(TMP, 'relay.out'), 'w');
  const relay = spawn(`${REPO}/.venv313/bin/python`, [`${REPO}/relay/herdr_relay.py`], {stdio: ['ignore', out, out], env});
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) {}
    await sleep(200);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  console:', m.text()); });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector('#agents .agent');
    await page.evaluate(() => {
      const keys = ['Architect 1', 'Reviewer 1'].map(n => convMemberKey(agents.find(a => a.label === n)));
      saveConvIndex([{id: 'c1', name: 'footer', created: Date.now(),
        members: keys.map((k, i) => ({key: k, added: Date.now(), label: ['Architect 1', 'Reviewer 1'][i]}))}]);
      openConversation('c1');
    });

    await page.click('#convArbitrator');
    await page.fill('#arbScope', 'Get the footer change reviewed, then stop.');
    await page.selectOption('#arbWho', {label: 'Arbitrator'});
    await page.click('#arbSetupBody .arb-btn.go');

    await page.waitForSelector('#arbStrip .arb-strip', {timeout: 30000});
    const running = await page.textContent('#arbStrip .arb-strip');
    check('the strip appears when the relay says the session exists', /Arbitrating|Deciding/.test(running), running);

    const id = await page.evaluate(() => arbSession && arbSession.id);
    check('and it is the relay that named it', /^s-/.test(id || ''), id);

    // The starter prompt's Enter left the arbitrator working. A person's arbitrator reads it and
    // goes quiet; this is that, and until it happens there is nothing free to decide with.
    await sleep(2.6e3);
    setStatus('a1:p3', 'done');

    // A member finishes a turn. That transition is the whole trigger.
    await endTurn('a1:p1');
    await page.waitForFunction(() => /Deciding/.test(document.querySelector('#arbStrip .arb-strip').textContent), null, {timeout: 30000});
    check('a member ending a turn puts the strip in Deciding', true);

    // The arbitrator's whole side of the protocol: one file, then its own turn ends.
    fs.writeFileSync(path.join(TMP, 'arb', 'arbitration', id, '0001-decision.json'), JSON.stringify({
      session_id: id, sequence: 1, gate: 'review', to: 'member-2',
      instruction: 'Check the footer change on mobile.', why: 'Ready for review.',
      ambiguity: 'low', decision_complexity: 'low'}));
    // A *transition*, not a status. The trigger prompt is typed into the arbitrator's pane, and the
    // fake herdr does not move a pane's status because something was typed at it — so a1:p3 is
    // still 'done' from the line above and setting it 'done' again is not a turn end. The relay
    // reads the drop box on the change into an ending state; with no change there is nothing to
    // read and the decision sits on disk for ever.
    await endTurn('a1:p3');

    // The tray stopped carrying the decision itself: it is a row of icons, a state and a budget,
    // and gate, target and why moved into the sheet the Log button opens. So "a decision arrived"
    // is asked of the session the relay pushed, and what it says is read where it is now drawn.
    await page.waitForFunction(
      () => arbSession && (arbSession.last_decision || {}).gate === 'review', null, {timeout: 30000});
    const last = await page.evaluate(() => arbSession.last_decision);
    check('the decision reaches the client by gate, target and why',
          last.to === 'member-2' && /Ready for review\./.test(last.why || ''), JSON.stringify(last));
    const decided = await page.textContent('#arbStrip .arb-strip');
    check('and the strip says where it is and what is left of its budget',
          /Arbitrating|Deciding/.test(decided) && /steps · \d+ min/.test(decided), decided);

    const herdr = fs.readFileSync(path.join(TMP, 'fake_herdr.log'), 'utf8');
    check('the instruction was typed at the member it named', herdr.includes('pane send-text a1:p2'), herdr.split('\n').slice(-4).join(' | '));

    // The sheet, over the wire: the relay answers `arb_detail` to this client alone, and what it
    // answers with is the only place the prompt the arbitrator was shown can be read back.
    await page.locator('#arbStrip').getByRole('button', {name: 'Log'}).click();
    // On the prose, not on the heading. The sheet draws immediately from the copy the thread's
    // bubbles already hold, and that copy is `brief` — gate, target and why, no prompt and no
    // instruction. Opening the sheet asks again without `brief`, and this waits for that answer.
    await page.waitForFunction(
      () => /Check the footer change on mobile\./.test(document.querySelector('#arbDetailBody').textContent),
      null, {timeout: 20000});
    const sheet = await page.textContent('#arbDetailBody');
    check('the sheet says which decision it was, and to whom',
          /#1 · review · Reviewer 1/.test(sheet), sheet.slice(0, 200));
    check('the sheet says what was decided and why', /Ready for review\./.test(sheet), sheet.slice(0, 200));
    check('what the arbitrator wrote', /Check the footer change on mobile\./.test(sheet), sheet.slice(0, 300));
    check('and where it was typed', /w?a1:p2/.test(sheet), sheet.slice(0, 300));
    await page.click('#arbSheet button[aria-label="Close"]');

    // And the other half of what a person reads back: the prompt itself, in the thread. It is on
    // the user's side because it is a prompt, so the badge is the only thing telling a reader that
    // nobody typed it (N8). Only the relay's record knows that, so the toggle goes on first.
    await page.evaluate(() => toggleConvLive());
    await page.waitForFunction(
      () => /Check the footer change on mobile\./.test(document.querySelector('#convViewThread').textContent),
      null, {timeout: 20000});
    // Asserted as a mark rather than as text: the badge is `arbSign()` beside the word, so the
    // thread's textContent says only "arbitrator" — which the session's own opening line in the
    // thread also says. The `.via` wrapper is what makes it a badge on a bubble, and the
    // arbitrator's own bubbles draw their sign outside it.
    const badges = await page.evaluate(
      () => document.querySelectorAll('#convViewThread .via .arb-sign').length);
    check('the prompt is badged as the arbitrator’s, not the reader’s', badges === 1,
          `${badges} arbitrator marks in the thread`);

    // --- a decision that sends nothing ------------------------------------------------------
    // `hold` records a reason, writes to nobody and leaves the session armed. It is drawn in the
    // thread like any other decision, and the one thing it must not be drawn as is a delivery the
    // relay could not confirm — which is what every no-send gate looked like before B3.
    await endTurn('a1:p2');
    await page.waitForFunction(
      () => /Deciding/.test(document.querySelector('#arbStrip .arb-strip').textContent),
      null, {timeout: 30000});
    fs.writeFileSync(path.join(TMP, 'arb', 'arbitration', id, '0002-decision.json'), JSON.stringify({
      session_id: id, sequence: 2, gate: 'hold',
      why: 'member-1 is still on the review — nothing to send yet.'}));
    await endTurn('a1:p3');

    await page.waitForFunction(
      () => arbSession && (arbSession.last_decision || {}).gate === 'hold', null, {timeout: 30000});
    check('a hold leaves the session armed rather than stopping it',
          /Arbitrating/.test(await page.textContent('#arbStrip .arb-strip')),
          await page.textContent('#arbStrip .arb-strip'));
    check('and nothing was typed at either member for it',
          fs.readFileSync(path.join(TMP, 'fake_herdr.log'), 'utf8')
            .split('\n').filter(l => /send-text a1:p[12]/.test(l)).length === 1,
          fs.readFileSync(path.join(TMP, 'fake_herdr.log'), 'utf8').split('\n')
            .filter(l => l.includes('send-text')).join(' | '));

    await page.waitForFunction(
      () => /nothing to send yet\./.test(document.querySelector('#convViewThread').textContent),
      null, {timeout: 20000});
    // Both no-send gates at once: the thread holds a `hold` here and a `review` that *was*
    // delivered, and only a decision the relay could not stand behind may wear the warning.
    const warned = await page.evaluate(() => [...document.querySelectorAll(
      '#convViewThread .conv-arb-to .warn')].map(el => el.textContent));
    check('a decision that sends nothing is not drawn as an unconfirmed delivery',
          warned.length === 0, warned.join(' | '));

    await page.getByRole('button', {name: 'Pause'}).click();
    await page.waitForFunction(() => /Paused/.test(document.querySelector('#arbStrip .arb-strip').textContent), null, {timeout: 15000});
    check('Pause stops it, from the page', true);

    // Not on the strip: ending and re-briefing sit behind the Edit dialog, because the strip is a
    // row of 28px squares over a thread being scrolled with a thumb. Still two presses — the
    // button arms on the first.
    await page.locator('#arbStrip').getByRole('button', {name: 'Edit'}).click();
    const end = page.getByRole('button', {name: /End session/});
    await end.click(); await end.click();
    await page.waitForFunction(() => document.querySelector('#arbStrip').textContent === '', null, {timeout: 15000});
    check('and ending takes the strip with it', true);
  } catch (e) {
    check('the run finished', false, String(e));
    try {
      console.log('  live:', JSON.stringify(await page.evaluate(() => ({
        rows: typeof convLiveRows !== 'undefined' ? convLiveRows : 'n/a',
        err: typeof convLiveError !== 'undefined' ? convLiveError : 'n/a',
        ids: [...document.querySelectorAll('[id*=conv]')].map(x => x.id).slice(0, 20),
      }))).slice(0, 1200));
    } catch (e2) { console.log('  live: unreadable', String(e2)); }
    console.log(fs.readFileSync(path.join(TMP, 'relay.out'), 'utf8').split('\n').slice(-25).join('\n'));
  } finally {
    await browser.close();
    relay.kill('SIGKILL');
  }
  console.log(fails ? `\n${fails} FAILED — ${TMP}` : '\nALL PASS');
  // Kept when it failed. The line above has always named this directory and the line below has
  // always deleted it, so the one run whose relay log is worth reading is the one that never had
  // one. A pass leaves nothing behind, as before.
  if (!fails) fs.rmSync(TMP, {recursive: true, force: true});
  process.exitCode = fails ? 1 : 0;
}
main();
