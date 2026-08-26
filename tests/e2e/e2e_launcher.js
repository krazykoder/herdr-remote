// A launcher tile pressed for real: a terminal that opens and runs a command, an agent that
// starts, and two agents plus an arbitrator that end up in one session.
//
// tests/e2e/browser/launcher.spec.js proves the section, the editor and what goes on the wire
// against the suite's fixed board — where nothing the relay starts ever appears, because
// `pane list` there is a constant. So a press is only ever half-observed: the message goes out,
// and nothing comes back to land on. This one holds the other half — a real relay and a pane list
// that grows as panes are made — which is the only arrangement where a serial spawn can be seen
// to be serial and a command can be seen to have landed in a pane.
//
// Not part of the Playwright suite: it owns its own relay and its own board, and it costs ~40
// seconds. Run it deliberately, after touching the launcher's dispatch:
//
//   node tests/e2e/e2e_launcher.js
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const PORT = Number(process.env.HERDR_E2E_QL_PORT || 8397);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-live-'));
const STATE = path.join(TMP, 'panes.json');
const PROJECTS = path.join(TMP, 'projects.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One pane to start with, so the page has an agent list to come up on. Everything else on this
// board is made by the launcher.
const PANES = [
  {pane_id: 'a1:p1', agent: 'claude', label: 'Architect 1', agent_status: 'idle',
   cwd: '/work/charts', workspace_id: 'a1', tab_id: 'a1:t1'},
];

const board = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const panesTyped = id => (board().find(p => p.pane_id === id) || {}).typed || [];

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  ${detail}`));
  if (!ok) fails++;
};

// The board is written by the relay's own herdr calls, so waiting for a pane is waiting for a
// file. Polled rather than slept on: a start goes through `workspace create` and then
// `agent start`, and how long that takes is not this test's business to guess.
async function waitForPanes(n, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (board().length >= n) return true;
    await sleep(200);
  }
  return false;
}

// A spawn is two herdr calls — the pane is created, and then the agent is attached to it — so a
// board that has grown is not yet a board with an agent on it. Waiting for the count alone reads
// the pane in between and finds `agent: ''`.
async function waitForAgents(n, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (board().filter(p => p.agent).length >= n) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  fs.mkdirSync(path.join(TMP, 'logs'), {recursive: true});
  fs.writeFileSync(STATE, JSON.stringify(PANES));
  // Two, both local, and the second one is only there so the arbitrated tile and the run tile can
  // be told apart by where they went.
  fs.writeFileSync(PROJECTS, JSON.stringify([
    {id: 'charts', label: 'Charts', cwd: '/work/charts', host: 'local'},
    {id: 'relay', label: 'Relay', cwd: '/work/relay', host: 'local'},
  ]));

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
    HERDR_PROJECTS_FILE: PROJECTS,
    HERDR_LOG_DIR: path.join(TMP, 'logs'),
    HERDR_STATE_DB: path.join(TMP, 'state.sqlite3'),
    HERDR_ARBITER_DB: path.join(TMP, 'arb', 'arbitration.sqlite3'),
    HERDR_CONV_LOG: '1',
    // All three gates the launcher's two kinds need: a terminal to run in, permission to create a
    // process at all, and the arbitration the third tile ends in.
    HERDR_ENABLE_TERMINAL: '1',
    HERDR_ENABLE_WRITE_EXT: '1',
    HERDR_ENABLE_ARBITER: '1',
  });
  const out = fs.openSync(path.join(TMP, 'relay.out'), 'w');
  const relay = spawn(`${REPO}/.venv313/bin/python`, [`${REPO}/relay/herdr_relay.py`],
                      {stdio: ['ignore', out, out], env});
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch (e) { /* not up */ }
    await sleep(200);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  console:', m.text()); });
  // The launch sheet, answered with nothing typed — a real answer: the launch is then named
  // `${noun} ${tag}`, which is the shape the checks below match on. The sheet itself is what
  // launcher.spec.js pins; here it is in the way of the thing being tested.
  const launch = async () => {
    await page.waitForSelector('#qlLaunchName', {timeout: 10000});
    const modal = page.locator('#launcherModal');
    // Two taps: the first arms Start, the second presses it.
    await modal.getByRole('button', {name: 'Start', exact: true}).click();
    await modal.getByRole('button', {name: 'Start?', exact: true}).click();
  };

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector('#agents .agent');
    await page.evaluate(() => { toggleSection('launcher', true); renderLauncher(); });

    // --- a run tile, built through the editor and pressed ---------------------------------
    // Through the form rather than into storage, because "a tile a person made works" is the
    // whole claim and a seeded one skips the half where the form has to produce a legal tile.
    await page.click('#launcher .section-header button[aria-label="Add a launcher tile"]');
    // The form opens on Start agents, so a command tile says which kind it is first.
    await page.locator('#launcherModal').getByRole('button', {name: 'Run a command'}).click();
    await page.fill('#qlName', 'Charts tests');
    await page.fill('#qlCommand', 'pytest -q tests/charts');
    // Scoped to the dialog: the Project strip in the form and the filter chips in the Agents
    // header are the same label on the same role, so an unscoped byRole matches both.
    await page.locator('#launcherModal').getByRole('button', {name: 'Charts', exact: true}).click();
    await page.click('#qlSave');
    await page.click('#launcherModal button[aria-label="Close"]');
    check('a tile built in the editor is on the page',
          await page.locator('.launcher-tile', {hasText: 'Charts tests'}).isVisible());

    const before = board().length;
    await page.locator('.launcher-tile', {hasText: 'Charts tests'}).click();
    await launch();
    check('pressing it opens a terminal', await waitForPanes(before + 1),
          JSON.stringify(board()));
    const shell = board()[board().length - 1];
    check('the terminal is at the Project’s cwd, which the browser never sent',
          shell.cwd === '/work/charts', shell.cwd);

    // The command itself, typed at the pane the relay just made. The fake keeps what was sent to
    // a pane and reads it back, so this is the command arriving rather than a message going out.
    const untilTyped = Date.now() + 30000;
    while (Date.now() < untilTyped && !panesTyped(shell.pane_id).some(t => /pytest -q/.test(t))) {
      await sleep(200);
    }
    check('and the command is typed into it',
          panesTyped(shell.pane_id).some(t => t.includes('pytest -q tests/charts')),
          JSON.stringify(panesTyped(shell.pane_id)));

    // The user is left in the pane it made, not on the list wondering where it went.
    await page.waitForFunction(id => activePane === id, shell.pane_id, {timeout: 20000})
      .then(() => check('and the page lands on that pane', true))
      .catch(e => check('and the page lands on that pane', false, String(e)));
    // Back to the list the way the app gets there. A press that lands on a pane leaves the list
    // hidden, and the next tile is then not clickable — not flaky, invisible.
    await page.evaluate(() => closeTerminal());
    await page.waitForSelector('.launcher-tile', {state: 'visible'});

    // --- one agent -------------------------------------------------------------------------
    await page.evaluate(() => {
      putLauncherTile({id: 'ql_one', label: 'Solo', action: 'spawn', project_id: 'relay',
                       members: [{name: 'claude', role: 'agent'}]});
      renderLauncher();
    });
    const agentsBefore = board().filter(p => p.agent).length;
    await page.locator('.launcher-tile', {hasText: 'Solo'}).click();
    await launch();
    check('a one-agent tile starts one session', await waitForAgents(agentsBefore + 1),
          JSON.stringify(board()));
    const solo = board()[board().length - 1];
    check('with the agent the tile named', solo.agent === 'claude', JSON.stringify(solo));
    check('in the Project the tile named', solo.cwd === '/work/relay', solo.cwd);
    // A roster of one gets a conversation too — it is what carries the name the launch was given,
    // and it outlives the pane id. Auto conversations are not the launcher's: the app opens one per
    // pane it sees, and the seed pane on this board has one, so only made ones are counted.
    await page.waitForFunction(() => loadConvIndex().filter(c => !c.auto).length === 1,
                               null, {timeout: 20000});
    const soloConv = await page.evaluate(() => loadConvIndex().filter(c => !c.auto)[0]);
    check('a roster of one lands in a conversation named for the launch',
          /^agent [a-z0-9]{5}$/.test(soloConv.name) && (soloConv.members || []).length === 1,
          JSON.stringify(soloConv));
    // The press ends on that conversation rather than on the pane — they were started together,
    // even when "they" is one.
    await page.waitForFunction(id => convViewId === id, soloConv.id, {timeout: 20000});
    // And the card stops saying it is opening. It is the only sign a press gives that it is still
    // working, so one that never clears reads as a start that never finished.
    const card = () => page.evaluate(() => ({
      text: document.getElementById('spawnStatusText').textContent,
      busy: !document.getElementById('spawnSpinner').hidden,
      shown: document.getElementById('spawnStatus').style.display !== 'none',
    }));
    await page.waitForFunction(() => document.getElementById('spawnSpinner').hidden,
                               null, {timeout: 20000})
      .then(async () => check('the status card stops spinning once the session has landed', true))
      .catch(async e => check('the status card stops spinning once the session has landed', false,
                              JSON.stringify(await card())));
    // Both notices the app draws over itself sit in one column at the top, stacked rather than
    // pinned to the same point: a relay error during a spawn is when the two have the most to say.
    const boxes = await page.evaluate(() => {
      showToast('relay said no');
      showSpawnStatus('Starting…', 'busy');
      const r = id => document.getElementById(id).getBoundingClientRect();
      return {toast: r('toast'), card: r('spawnStatus')};
    });
    check('the notices are at the top of the screen, and do not sit on each other',
          boxes.toast.top < 40 && boxes.card.top >= boxes.toast.bottom,
          JSON.stringify(boxes));
    await page.evaluate(() => {
      document.getElementById('toast').style.display = 'none';
      showSpawnStatus('');
    });

    // Back to the list the way the app gets there. A press that lands somewhere leaves the list
    // hidden, and the next tile is then not clickable — not flaky, invisible.
    await page.evaluate(() => showLanding());
    await page.waitForSelector('.launcher-tile', {state: 'visible'});

    // --- two agents and an arbitrator ------------------------------------------------------
    await page.evaluate(() => {
      putLauncherTile({id: 'ql_arb', label: 'Review pair', action: 'spawn', project_id: 'charts',
                       scope: 'Which approach ships',
                       members: [{name: 'claude', role: 'proposer'},
                                 {name: 'codex', role: 'critic'}],
                       arbitrator: {name: 'claude'}});
      renderLauncher();
    });
    check('an arbitrated tile reads as one on the page',
          (await page.locator('.launcher-tile', {hasText: 'Review pair'}).textContent())
            .includes('Arbitrated'));

    // Enabled before it is pressed. A refused tile does nothing when clicked, and "nothing
    // happened" is the same shape as a spawn that failed — this says which.
    const arbTile = page.locator('.launcher-tile[data-tile="ql_arb"]');
    check('and it is pressable on a relay with arbitration on',
          (await arbTile.getAttribute('aria-disabled')) === 'false',
          await arbTile.getAttribute('title'));

    const beforeArb = board().length;
    await page.locator('.launcher-tile', {hasText: 'Review pair'}).click();
    await launch();
    // Three, and one at a time: next_role_label reads the live agent list to pick a name, so two
    // starts in flight can choose the same one and the relay renames around the collision.
    // A refusal is a toast, so a press that went nowhere says why here rather than only as a
    // board that did not grow.
    const ok3 = await waitForAgents(agentsBefore + 4, 90000);
    check('it starts three panes', ok3,
          (await page.evaluate(() => {
            const t = document.getElementById('toast');
            return t && t.style.display !== 'none' ? `toast: ${t.textContent}` : '';
          })) + ' ' + JSON.stringify(board()));
    const three = board().slice(beforeArb);
    check('two members and an arbitrator, in the order the tile lists them',
          three.map(p => p.agent).join(',') === 'claude,codex,claude',
          three.map(p => `${p.agent}/${p.label}`).join(' '));

    // The conversation holds the two, and not the third: an arbitrator is not a participant in
    // the conversation it decides about, it is the one reading it.
    await page.waitForFunction(() => loadConvIndex().filter(c => !c.auto).length === 2,
                               null, {timeout: 20000});
    const conv = await page.evaluate(() =>
      loadConvIndex().filter(c => !c.auto).find(c => (c.members || []).length === 2));
    check('the two members land in one conversation named for the launch',
          !!conv && /^conversation [a-z0-9]{5}$/.test(conv.name),
          JSON.stringify(conv));

    // And the session itself, which is the relay's to confirm. arbSessions is what it broadcast.
    await page.waitForFunction(() => arbSessions.length === 1, null, {timeout: 40000})
      .then(() => check('and the relay says an arbitration session exists', true))
      .catch(e => check('and the relay says an arbitration session exists', false, String(e)));
    const session = await page.evaluate(() => arbSessions[0] || null);
    if (session) {
      check('over the conversation the launcher just made',
            session.conversation === conv.id, `${session.conversation} vs ${conv.id}`);
      check('with the scope the tile carried',
            session.scope === 'Which approach ships', session.scope);
      check('the arbitrator is the third pane, and outside the two',
            (session.arbitrator || {}).pane_id === three[2].pane_id,
            `${(session.arbitrator || {}).pane_id} vs ${three[2].pane_id}`);
      check('and the members are the first two, with their roles',
            (session.members || []).map(m => m.pane_id).join(',')
              === three.slice(0, 2).map(p => p.pane_id).join(','),
            JSON.stringify((session.members || []).map(m => m.pane_id)));
    }

    // The arbitrator was briefed — the one thing that separates an appointed session from three
    // panes that happen to exist. The brief is typed at its pane, so the board has it.
    check('the arbitrator was briefed at its own pane',
          panesTyped(three[2].pane_id).length > 0,
          JSON.stringify(panesTyped(three[2].pane_id)).slice(0, 200));

    // --- repointing a tile whose Project has gone -------------------------------------------
    // Reloaded rather than navigated back: the arbitrated press ends in the conversation it made,
    // and the landing page is one reload away. The tiles come back with it — which is the point.
    await page.reload();
    await page.waitForSelector('#agents .agent');
    await page.evaluate(() => {
      putLauncherTile({id: 'ql_stale', label: 'Stale', action: 'run', project_id: 'gone',
                       command: 'echo hi'});
      renderLauncher();
    });
    const stale = page.locator('.launcher-tile[data-tile="ql_stale"]');
    check('a tile pointing at a Project this relay never heard of is disabled',
          (await stale.getAttribute('aria-disabled')) === 'true');
    // force: aria-disabled fails the actionability check, and this tile is meant to be pressed —
    // it is a real <button> whose handler is what offers the repoint.
    await stale.click({force: true});
    await page.waitForSelector('#qlName', {timeout: 10000});
    check('and pressing it opens the tile on the field that is wrong',
          (await page.textContent('#launcherEditTitle')) === 'Edit tile');
    await page.locator('#launcherModal').getByRole('button', {name: 'Relay', exact: true}).click();
    await page.click('#qlSave');
    await page.click('#launcherModal button[aria-label="Close"]');
    check('repointing re-enables it', (await stale.getAttribute('aria-disabled')) === 'false');

    const beforeStale = board().length;
    await stale.click();
    await launch();
    check('and it runs where it was repointed to', await waitForPanes(beforeStale + 1),
          JSON.stringify(board()));
    const moved = board()[board().length - 1];
    check('at the new Project’s cwd', moved.cwd === '/work/relay', moved.cwd);
  } catch (e) {
    check('the run finished', false, String(e));
    console.log(fs.readFileSync(path.join(TMP, 'relay.out'), 'utf8').split('\n').slice(-25).join('\n'));
  } finally {
    await browser.close();
    relay.kill('SIGKILL');
  }
  console.log(fails ? `\n${fails} FAILED — ${TMP}` : '\nALL PASS');
  if (!fails) fs.rmSync(TMP, {recursive: true, force: true});
  process.exit(fails ? 1 : 0);
}
main();
