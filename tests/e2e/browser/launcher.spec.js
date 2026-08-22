// The launcher, in a real browser: the section, the editor, and repointing a tile whose Project
// has gone.
//
// tests/test_launcher*.js cover the schema, the dispatch and the editor against stub DOMs — three
// suites, and none of them can see the page. What is left for a browser is the half a stub agrees
// with whatever it is told: that the section is on screen at all, that the dialog's fields are
// where the markup says they are, that a tile written here survives a reload, and that a press
// reaches the relay. Pressing for real — panes appearing, a command landing in one — needs a board
// that moves, which is tests/e2e/e2e_launcher.js.
//
//   npx playwright test launcher
const path = require('node:path');
const fs = require('node:fs');
const {test, expect, startRelay, PORT0, ROOT} = require('./fixtures');

// Its own relay, because the worker's is started with no Projects — and a launcher tile names one
// in every shape it has. Two, both local: the second is what a repoint has to move onto.
let relay = null;

test.beforeAll(async ({}, workerInfo) => {
  const logs = path.join(ROOT, 'tests', 'e2e', 'logs', `ql-w${workerInfo.parallelIndex}`);
  fs.mkdirSync(logs, {recursive: true});
  const projects = path.join(logs, 'projects.json');
  fs.writeFileSync(projects, JSON.stringify([
    {id: 'charts', label: 'Charts', cwd: '/work/charts', host: 'local'},
    {id: 'empty', label: 'Empty Project', cwd: '/work/empty', host: 'local'},
  ]));
  relay = await startRelay({
    port: PORT0 + 200 + workerInfo.parallelIndex * 2,
    logs, name: 'relay_launcher.out',
    env: {HERDR_PROJECTS_FILE: projects},
  });
});

test.afterAll(() => { if (relay) relay.stop(); });

const open = async page => {
  await page.goto(relay.url);
  await expect(page.locator('#agents .agent').first()).toBeVisible();
};

// Everything inside the dialog is reached through this rather than off the page. The Project strip
// in the form is the same markup as the filter chips in the Agents header — same label, same role
// — so an unscoped byRole('Charts') is two buttons and a strict-mode violation, not a flaky one.
const dlg = page => page.locator('#launcherModal');

// Tiles written straight into storage, for the tests that are about what the page does with one
// rather than about the form that makes it. renderLauncher is the repaint every other writer of
// this document goes through, so it is the one used here too.
const seed = (page, tiles) => page.evaluate(t => {
  saveLauncher(t);
  toggleSection('launcher', true);
  renderLauncher();
}, tiles);

const RUN = {id: 'ql_run', label: 'Run the tests', action: 'run', project_id: 'charts',
             command: 'pytest -q'};

// --- the section ---

test('a tile is on the page, with its payload on it rather than behind a hover', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const tile = page.locator('.launcher-tile[data-tile="ql_run"]');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('Run the tests');
  // The whole of this feature's answer to a mislabelled action: the name is a claim, and this is
  // the evidence. A tile whose payload only appeared on hover would say nothing on a phone.
  await expect(tile).toContainText('pytest -q');
  await expect(tile).toContainText('Charts');
  await expect(tile).toHaveAttribute('aria-disabled', 'false');
});

test('the section leads the page and carries its own way in', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const order = await page.evaluate(() => ['launcher', 'agents']
    .map(id => document.getElementById(id))
    .filter(el => el.offsetParent !== null)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(el => el.id));
  expect(order).toEqual(['launcher', 'agents']);
  // Drawn whether or not there is anything under it — an entry point that only appears once you
  // already have a tile cannot be how the first one is made.
  await expect(page.locator('#launcher .section-header button')).toHaveText('Edit');
});

test('an empty launcher still offers the one thing there is to do', async ({page}) => {
  await open(page);
  // Seeded empty rather than assumed empty. This file runs its own relay, so the suite's
  // freshState fixture — which empties the *worker* relay's documents between tests — does not
  // reach it, and the launcher another test here wrote is still on the relay when this page
  // connects. Every test below that starts from nothing says so.
  await seed(page, []);
  await expect(page.locator('#launcher .section-header button')).toHaveText('+ New');
  await expect(page.locator('.launcher-tile')).toHaveCount(0);
});

// --- the editor ---

test('a tile written through the form is on the page, and survives a reload', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.click('#launcher .section-header button');
  await expect(page.locator('#launcherModal')).toBeVisible();
  await page.click('#qlAdd');
  await page.fill('#qlName', 'Charts tests');
  await page.fill('#qlCommand', 'pytest -q tests/charts');
  await dlg(page).getByRole('button', {name: 'Charts', exact: true}).click();
  await page.click('#qlSave');

  // Back on the list, and on the page behind it.
  await expect(page.locator('#launcherEditTitle')).toHaveText('Launcher');
  await page.click('#launcherModal button[aria-label="Close"]');
  const tile = page.locator('.launcher-tile', {hasText: 'Charts tests'});
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('pytest -q tests/charts');

  // Reloaded rather than re-rendered: what is being asked is whether it was written down, and a
  // repaint would answer with what is already in memory.
  await page.reload();
  await expect(page.locator('.launcher-tile', {hasText: 'Charts tests'})).toBeVisible();
});

test('the form refuses a tile the presser could not run, and says which field', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.click('#launcher .section-header button');
  await page.click('#qlAdd');
  await page.fill('#qlCommand', 'pytest');
  await page.click('#qlSave');
  await expect(page.locator('#qlError')).toHaveText('Give it a name');
  await expect(page.locator('#launcherEditTitle')).toHaveText('New tile', 'still on the form');
});

test('an arbitrated tile is built from the form and reads as one', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.click('#launcher .section-header button');
  await page.click('#qlAdd');
  await page.fill('#qlName', 'Review pair');
  await dlg(page).getByRole('button', {name: 'Start agents'}).click();
  await dlg(page).getByRole('button', {name: '+ claude'}).click();
  // The arbitrator row is offered at exactly two, which is where §14.1 fixes an arbitrated roster.
  await expect(dlg(page).locator('.start-field', {hasText: 'Arbitrator'})).toHaveCount(0);
  await dlg(page).getByRole('button', {name: '+ codex'}).click();
  await expect(dlg(page).locator('.start-field', {hasText: 'Arbitrator'})).toBeVisible();
  await page.fill('#qlRole0', 'proposer');
  await page.fill('#qlRole1', 'critic');
  await dlg(page).locator('.start-field', {hasText: 'Arbitrator'})
    .getByRole('button', {name: 'claude', exact: true}).click();
  await page.fill('#qlScope', 'Which approach ships');
  await page.click('#qlSave');
  await page.click('#launcherModal button[aria-label="Close"]');

  const tile = page.locator('.launcher-tile', {hasText: 'Review pair'});
  await expect(tile).toContainText('Arbitrated');
  await expect(tile).toContainText('claude + codex ⚖ claude');
  expect(await page.evaluate(() => loadLauncher()[0])).toMatchObject({
    action: 'spawn', project_id: 'charts', scope: 'Which approach ships',
    members: [{name: 'claude', role: 'proposer'}, {name: 'codex', role: 'critic'}],
    arbitrator: {name: 'claude'},
  });
});

test('tiles are reordered from the list, and the order is what was written down', async ({page}) => {
  await open(page);
  await seed(page, [RUN, Object.assign({}, RUN, {id: 'ql_two', label: 'Second'})]);
  await page.click('#launcher .section-header button');
  await dlg(page).getByRole('button', {name: 'Move Second up'}).click();
  await page.click('#launcherModal button[aria-label="Close"]');
  await page.reload();
  expect(await page.evaluate(() => loadLauncher().map(t => t.label)))
    .toEqual(['Second', 'Run the tests']);
  // And on screen in that order, which is the half a stored array cannot answer.
  await expect(page.locator('.launcher-tile .launcher-name'))
    .toHaveText(['Second', 'Run the tests']);
});

test('deleting asks first, and takes the tile off the page', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  page.on('dialog', d => d.accept());
  await page.click('#launcher .section-header button');
  await dlg(page).getByRole('button', {name: 'Delete Run the tests'}).click();
  await page.click('#launcherModal button[aria-label="Close"]');
  await expect(page.locator('.launcher-tile')).toHaveCount(0);
});

// --- repoint ---

test('a tile whose Project is gone says so, and pressing it offers the fix', async ({page}) => {
  await open(page);
  await seed(page, [Object.assign({}, RUN, {project_id: 'deleted'})]);
  const tile = page.locator('.launcher-tile[data-tile="ql_run"]');
  await expect(tile).toHaveAttribute('aria-disabled', 'true');
  await expect(tile).toContainText('Missing Project');

  // Disabled, never hidden — and a gone Project is the one closed gate the presser can fix, so
  // the press opens the tile on that field rather than reporting a dead end.
  //
  // force, because aria-disabled fails Playwright's actionability check and this tile is meant to
  // be pressed anyway: it is a real <button>, never `disabled`, and its handler is what offers the
  // repoint. A real finger lands on it; only the harness needs telling.
  await tile.click({force: true});
  await expect(page.locator('#launcherModal')).toBeVisible();
  await expect(page.locator('#launcherEditTitle')).toHaveText('Edit tile');
  await expect(page.locator('#qlName')).toHaveValue('Run the tests');

  await dlg(page).getByRole('button', {name: 'Empty Project', exact: true}).click();
  await page.click('#qlSave');
  await page.click('#launcherModal button[aria-label="Close"]');

  await expect(tile).toHaveAttribute('aria-disabled', 'false');
  await expect(tile).toContainText('Empty Project');
  // One field. Everything else the tile was carrying is still on it.
  await expect(tile).toContainText('pytest -q');
  expect(await page.evaluate(() => loadLauncher()[0].command)).toBe('pytest -q');
});

// --- what a press puts on the wire ---

test('pressing a run tile opens a terminal for the Project it names', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  page.on('dialog', d => d.accept());
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  await expect.poll(() => sent.filter(m => m.type === 'open_terminal')).toHaveLength(1);
  // Exactly the fields relay/start_agent.py accepts. `extra = set(msg) - base_fields` is a hard
  // refusal there, so a stray key is not a warning — it is the whole message rejected, silently.
  expect(sent.find(m => m.type === 'open_terminal')).toEqual({
    type: 'open_terminal', project_id: 'charts', placement: 'new_workspace',
    label: 'Run the tests',
  });
});

test('saying no to the confirm sends nothing', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  let asked = '';
  page.on('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  // The command verbatim in the confirm, which is what makes dismissing it a decision.
  await expect.poll(() => asked).toContain('pytest -q');
  await page.waitForTimeout(500);
  expect(sent.filter(m => m.type === 'open_terminal')).toHaveLength(0);
});
