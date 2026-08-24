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

// Answering the launch sheet: pick a Project when the tile does not name one, type a name, then
// the two taps Start takes. Every press goes through this now — the sheet is where the confirm is
// read, where a template is pointed at a tree and where the launch is named.
const launch = async (page, {project, name} = {}) => {
  await expect(page.locator('#qlLaunchName')).toBeVisible();
  if (project) await dlg(page).getByRole('button', {name: project, exact: true}).click();
  if (name) await page.fill('#qlLaunchName', name);
  const start = dlg(page).getByRole('button', {name: 'Start', exact: true});
  await start.click();
  // Armed, then fired. A tile starts sessions in someone else's checkout, so the tap that does it
  // is deliberately not the first one.
  await expect(dlg(page).getByRole('button', {name: 'Start?', exact: true})).toBeVisible();
  await dlg(page).getByRole('button', {name: 'Start?', exact: true}).click();
};

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
  // already have a tile cannot be how the first one is made. Two of them once there is a tile,
  // and + is always the right-hand one: an add button that moves as soon as it has been used is
  // the shape of a button people stop finding.
  await expect(page.locator('#launcher > .section-header:first-child button')).toHaveText(['Edit', '+ New']);
});

test('an empty launcher still offers the one thing there is to do', async ({page}) => {
  await open(page);
  // Seeded empty rather than assumed empty. This file runs its own relay, so the suite's
  // freshState fixture — which empties the *worker* relay's documents between tests — does not
  // reach it, and the launcher another test here wrote is still on the relay when this page
  // connects. Every test below that starts from nothing says so.
  await seed(page, []);
  await expect(page.locator('#launcher > .section-header:first-child button')).toHaveText(['+ New']);
  await expect(page.locator('.launcher-tile')).toHaveCount(0);
  // And it opens the form rather than the list: that button says Add, and a list is not what
  // adding looks like.
  await page.click('#launcher > .section-header:first-child button');
  await expect(page.locator('#launcherEditTitle')).toHaveText('New tile');
  await page.click('#launcherModal button[aria-label="Close"]');
});

// --- the editor ---

test('a tile written through the form is on the page, and survives a reload', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.click('#launcher > .section-header:first-child button');
  await expect(page.locator('#launcherModal')).toBeVisible();
  // The form opens on Start agents now, so a command tile says so first.
  await dlg(page).getByRole('button', {name: 'Run a command'}).click();
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
  await page.click('#launcher > .section-header:first-child button');
  await dlg(page).getByRole('button', {name: 'Run a command'}).click();
  await page.fill('#qlCommand', 'pytest');
  await page.click('#qlSave');
  await expect(page.locator('#qlError')).toHaveText('Give it a name');
  await expect(page.locator('#launcherEditTitle')).toHaveText('New tile', 'still on the form');
});

test('custom configs are available for both tile roster and arbitrator', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.evaluate(() => {
    startOptions.configs = [{id: 'oclaude', label: 'oClaude', kind: 'claude'}];
    openLauncherEdit();
    launcherNewTile();
  });
  await dlg(page).getByRole('button', {name: '+custom', exact: true}).first().click();
  await dlg(page).getByRole('button', {name: 'oClaude', exact: true}).first().click();
  await dlg(page).getByRole('button', {name: '+ codex', exact: true}).click();
  const arb = dlg(page).locator('.start-field').filter({hasText: /^Arbitrator/});
  await arb.getByRole('button', {name: '+custom', exact: true}).click();
  await arb.getByRole('button', {name: 'oClaude', exact: true}).click();
  await expect(page.locator('#qlRole0')).toBeVisible();
});

test('an arbitrated tile is built from the form and reads as one', async ({page}) => {
  await open(page);
  await seed(page, []);
  await page.click('#launcher > .section-header:first-child button');
  await page.fill('#qlName', 'Review pair');
  await dlg(page).getByRole('button', {name: 'Start agents'}).click();
  await dlg(page).getByRole('button', {name: '+ claude'}).click();
  // One agent is nothing to decide between, so the row is not offered yet.
  await expect(dlg(page).locator('.start-field').filter({hasText: /^Arbitrator/})).toHaveCount(0);
  await dlg(page).getByRole('button', {name: '+ codex'}).click();
  await expect(dlg(page).locator('.start-field').filter({hasText: /^Arbitrator/})).toBeVisible();
  // The roles come with the arbitrator and not before it: a role is what the arbitrator is told a
  // member is for, so there is nothing to ask until there is one.
  await expect(page.locator('#qlRole0')).toHaveCount(0);
  await dlg(page).locator('.start-field').filter({hasText: /^Arbitrator/})
    .getByRole('button', {name: 'claude', exact: true}).click();
  await page.fill('#qlRole0', 'proposer');
  await page.fill('#qlRole1', 'critic');
  await page.fill('#qlScope', 'Which approach ships');
  // A new tile starts as a template — no Project, answered at the press — so the one this asserts
  // has to be chosen here rather than inherited.
  await dlg(page).locator('.start-field', {hasText: 'Project'})
    .getByRole('button', {name: 'Charts', exact: true}).click();
  await page.click('#qlSave');
  await page.click('#launcherModal button[aria-label="Close"]');

  const tile = page.locator('.launcher-tile', {hasText: 'Review pair'});
  await expect(tile).toContainText('Arbitrated');
  await expect(tile).toContainText('claude + codex ⚖ claude');
  expect(await page.evaluate(() => loadLauncher()[0])).toMatchObject({
    action: 'spawn', project_id: 'charts', scope: 'Which approach ships',
    members: [{name: 'claude', role: 'proposer', at: 'architect-prompt'},
              {name: 'codex', role: 'critic', at: 'architect-prompt'}],
    arbitrator: {name: 'claude'},
  });
});

test('tiles are reordered from the list, and the order is what was written down', async ({page}) => {
  await open(page);
  await seed(page, [RUN, Object.assign({}, RUN, {id: 'ql_two', label: 'Second'})]);
  await page.click('#launcher > .section-header:first-child button');
  await dlg(page).getByRole('button', {name: 'Move Second up'}).click();
  await page.click('#launcherModal button[aria-label="Close"]');
  await page.reload();
  expect(await page.evaluate(() => loadLauncher().map(t => t.label)))
    .toEqual(['Second', 'Run the tests']);
  // And on screen in that order, which is the half a stored array cannot answer. Matched on the
  // start of the line: the name carries its `@project` badge inside the same span.
  await expect(page.locator('.launcher-tile .launcher-name'))
    .toHaveText([/^Second\b/, /^Run the tests\b/]);
});

test('deleting asks first, and takes the tile off the page', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  page.on('dialog', d => d.accept());
  await page.click('#launcher > .section-header:first-child button');
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
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  await launch(page, {name: 'Tonight'});
  await expect.poll(() => sent.filter(m => m.type === 'open_terminal')).toHaveLength(1);
  const msg = sent.find(m => m.type === 'open_terminal');
  // Exactly the fields relay/start_agent.py accepts. `extra = set(msg) - base_fields` is a hard
  // refusal there, so a stray key is not a warning — it is the whole message rejected, silently.
  expect(Object.keys(msg).sort())
    .toEqual(['label', 'placement', 'project_id', 'type']);
  expect(msg.project_id).toBe('charts');
  expect(msg.placement).toBe('new_workspace');
  // The name typed, plus this launch's tag — one press is one tag, worn by everything it starts.
  expect(msg.label).toMatch(/^Tonight [a-z0-9]{5}$/);
});

test('tiles are banded by Project, and a template is pressed into one', async ({page}) => {
  await open(page);
  await seed(page, [Object.assign({}, RUN, {id: 'ql_tpl', label: 'Anywhere', project_id: ''}), RUN]);
  // Templates first: they are the ones pressable anywhere, so they are what a reader is looking
  // for when they do not already know which tree they want.
  await expect(page.locator('#launcher .launcher-band')).toHaveText(['Templates', 'Charts']);
  // The app's one nomenclature for a Project, beside the name — and `@ask` where a template's
  // would be, which is the reader's warning that pressing it asks one more question.
  await expect(page.locator('.launcher-tile[data-tile="ql_tpl"] .badge.proj'))
    .toHaveText('@ask');

  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  await page.locator('.launcher-tile[data-tile="ql_tpl"]').click();
  // One sheet, both questions: a template's Project and the launch's name, asked where the confirm
  // is read rather than in two dialogs of different kinds.
  await expect(page.locator('#launcherEditTitle')).toHaveText('Launch: Anywhere');
  await launch(page, {project: 'Charts', name: 'Tonight'});
  await expect.poll(() => sent.filter(m => m.type === 'open_terminal')).toHaveLength(1);
  expect(sent.find(m => m.type === 'open_terminal').project_id).toBe('charts');
  // And the tile is still a template — the choice was for this press, not written back.
  expect(await page.evaluate(() =>
    loadLauncher().find(t => t.id === 'ql_tpl').project_id)).toBe('');
});

test('a launch nobody named is named for what it makes, plus a tag', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  await launch(page);
  await expect.poll(() => sent.filter(m => m.type === 'open_terminal')).toHaveLength(1);
  expect(sent.find(m => m.type === 'open_terminal').label).toMatch(/^terminal [a-z0-9]{5}$/);
});

test('cancelling the sheet sends nothing', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  // The command verbatim on the sheet, which is what makes cancelling it a decision.
  await expect(dlg(page).locator('.ql-launch-say')).toContainText('pytest -q');
  await dlg(page).getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.waitForTimeout(500);
  expect(sent.filter(m => m.type === 'open_terminal')).toHaveLength(0);
});

test('one tap only arms the Start, it does not press it', async ({page}) => {
  await open(page);
  await seed(page, [RUN]);
  const sent = [];
  await page.exposeFunction('__note', m => sent.push(m));
  await page.evaluate(() => {
    const real = ws.send.bind(ws);
    ws.send = data => { try { __note(JSON.parse(data)); } catch (e) { /* not json */ } return real(data); };
  });
  await page.locator('.launcher-tile[data-tile="ql_run"]').click();
  await dlg(page).getByRole('button', {name: 'Start', exact: true}).click();
  await expect(dlg(page).getByRole('button', {name: 'Start?', exact: true})).toBeVisible();
  await page.waitForTimeout(500);
  expect(sent.filter(m => m.type === 'open_terminal')).toHaveLength(0);
});
