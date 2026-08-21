// A shell pane, driven the way a person drives one: open it, type a command, send it.
//
// The relay confirms a submit by watching the pane's `agent_status` until it says the pane took
// what it was handed. A shell has no agent and therefore no status — a real `pane list` says
// `unknown` — so watching one means waiting out the timeout and giving up with the command sitting
// at the prompt, unpressed. Nothing on screen says so, which is why this reads the fake herdr's log
// instead: an Enter that was never sent is invisible from the browser.
const fs = require('fs');
const {test, expect} = require('./fixtures');

const TERMINAL = 'build watch';   // the shell pane in tests/e2e/bin/herdr, w9:p1
const PANE = 'w9:p1';

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

// Read the log from the end: the relay polls constantly, so the interesting lines are the last few.
const wrote = (logPath, verb) => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
  .trim().split('\n').filter(l => l.includes(` pane ${verb} ${PANE}`));

async function openTerminal(page) {
  await page.locator('#agentListView .agent', {hasText: TERMINAL}).click();
  await expect(page.locator('#terminalView')).toHaveClass(/active/);
  await expect(page.locator('#termContent')).toContainText('done.');
}

test('a command typed into a shell is pasted and entered', async ({page, herdrLog}) => {
  const before = wrote(herdrLog, 'send-keys').length;
  await openTerminal(page);
  await page.locator('#termInput').fill('ls -la');
  await page.locator('.term-input-side .send').click();

  // The paste, then the Enter that runs it. Polled: the relay settles between the two, and the
  // settle is measured in hundreds of milliseconds.
  await expect.poll(() => wrote(herdrLog, 'send-text').length, {timeout: 5000}).toBeGreaterThan(0);
  await expect.poll(() => wrote(herdrLog, 'send-keys').length, {timeout: 5000})
    .toBeGreaterThan(before);
  expect(wrote(herdrLog, 'send-text').pop()).toContain('ls -la');
  expect(wrote(herdrLog, 'send-keys').pop()).toContain('Enter');

  // And the composer is emptied, which is the app saying it went.
  await expect(page.locator('#termInput')).toHaveValue('');
});

// The Clear and Quit buttons send `clear` and `exit` down the same path. Short, generated, and
// broken by the same missing Enter — a shell that is handed `clear` and never entered just shows
// the word sitting at its prompt.
test('the shell’s own commands are entered too', async ({page, herdrLog}) => {
  const before = wrote(herdrLog, 'send-keys').length;
  await openTerminal(page);
  await page.locator('#fireBtn').click();  // the menu the undoable buttons live behind
  await page.locator('#clsBtn').click();   // armed
  await page.locator('#clsBtn').click();   // fired
  await expect.poll(() => wrote(herdrLog, 'send-keys').length, {timeout: 5000})
    .toBeGreaterThan(before);
  expect(wrote(herdrLog, 'send-text').pop()).toContain('clear');
});
