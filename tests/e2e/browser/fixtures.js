// One relay per worker, so the browser suite can run in parallel.
//
// The relay is one process holding one fake herdr's state — renames, started agents, sent keys —
// and workers sharing it would race on all of it. So each worker gets its own relay on its own
// port, with its own log and its own write log, and `baseURL` points at that one. Nothing is
// shared between workers, which is what makes `fullyParallel` safe.
//
// Specs require this module instead of '@playwright/test'; `test` and `expect` are the same
// objects otherwise.
const base = require('@playwright/test');
const {spawn, spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..', '..');
const PORT0 = Number(process.env.HERDR_PW_PORT || 8402);

// The shell's own HERDR_* settings are not this suite's. A developer with HERDR_EXTERNAL_PORT,
// HERDR_REMOTES or a relay token exported would otherwise get a test relay that opens a second
// listener, polls their real machines over SSH, or rejects the browser — every one of them a
// failure that reproduces on one laptop and nowhere else. The suite states its whole environment.
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_') && !k.startsWith('FAKE_')));
}

// Ready when the page it serves is served. A socket that accepts is not the same thing: the relay
// binds before it has read index.html off disk.
async function waitForRelay(url, proc, logFile) {
  // Why it died is the only thing worth knowing when it does, and it is in the log it was writing.
  const died = () => {
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n'); }
    catch (e) { /* nothing written */ }
    return new Error(`relay exited with ${proc.exitCode}\n${tail}`);
  };
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw died();
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(2000)});
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`relay at ${url} never came up`);
}

// The relay's shared-state store, emptied between tests.
//
// Those four documents are the one thing in this suite that outlives a BrowserContext: Playwright
// gives every test fresh localStorage, and the relay then hands the new page whatever the previous
// test left on the relay. Without this, a spec's pairs and conversations leak into every spec that
// runs after it in the same worker — and the leak is invisible until an assertion about "nothing is
// paired" fails in a file that never mentions pairs.
//
// Deleting the rows from outside the relay's own connection is safe: the file is in WAL mode and
// belongs to this worker, and the relay reads it fresh on the next state_get.
function clearSharedState(dbPath) {
  if (!fs.existsSync(dbPath)) return;               // nothing has been written yet
  const r = spawnSync(path.join(ROOT, '.venv313', 'bin', 'python'),
    ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM docs"); ' +
           'c.commit(); c.close()', dbPath],
    {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`could not clear ${dbPath}: ${r.stderr || r.error}`);
}

const test = base.test.extend({
  relayURL: [async ({}, use, workerInfo) => {
    // Two ports apart: the relay opens a UDP listener at port+1 for plugin push.
    const port = PORT0 + workerInfo.parallelIndex * 2;
    const logs = path.join(ROOT, 'tests', 'e2e', 'logs', `w${workerInfo.parallelIndex}`);
    fs.mkdirSync(logs, {recursive: true});
    const logFile = path.join(logs, 'relay.out');
    const out = fs.openSync(logFile, 'w');
    const proc = spawn(path.join(ROOT, '.venv313', 'bin', 'python'),
      [path.join(ROOT, 'relay', 'herdr_relay.py')], {
        stdio: ['ignore', out, out],
        env: {
          ...cleanEnv(),
          PATH: `${path.join(ROOT, 'tests', 'e2e', 'bin')}:${process.env.PATH}`,  // fake ssh
          HERDR_BIN: path.join(ROOT, 'tests', 'e2e', 'bin', 'herdr'),             // fake herdr
          FAKE_LOG: path.join(logs, 'fake_herdr.log'),
          HERDR_RELAY_PORT: String(port),
          // Loopback and nothing else. No HERDR_EXTERNAL_PORT, so there is no second listener for
          // a tunnel to terminate on, and nothing here ever launches one — that is start.sh's job
          // and the suite does not run it. A loopback bind also takes mDNS out, so a test run
          // advertises nothing on the network.
          HERDR_LAN_BIND: '127.0.0.1',
          HERDR_LAN_OPEN: '1',       // no token: the browser connects straight to its own origin
          HERDR_ENABLE_TERMINAL: '1',
          HERDR_ENABLE_WRITE_EXT: '1',
          // The durable record, so the thread's "read the relay's record" toggle has something to
          // read. Both databases are named explicitly and land in this worker's own log directory.
          // Left unset they default under the repo root, where every worker shares one file — and
          // where a developer running the suite writes into the record their own relay is keeping.
          // HERDR_STATE_DIR used to stand here and is read by nothing in the relay, so it never
          // moved anything.
          HERDR_CONV_LOG: '1',
          HERDR_ARBITER_DB: path.join(logs, 'arbitration.sqlite3'),
          HERDR_STATE_DB: path.join(logs, 'state.sqlite3'),
          // No HERDR_REMOTES: one host keeps the fake's deliberate cross-host pane-ID collisions
          // out of the way, and the Projects fixture is not loaded because its entries name it.
        },
      });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForRelay(`${url}/`, proc, logFile);
      await use(url);
    } finally {
      proc.kill('SIGTERM');
      fs.closeSync(out);
    }
  }, {scope: 'worker'}],

  stateDB: [async ({}, use, workerInfo) => {
    await use(path.join(ROOT, 'tests', 'e2e', 'logs', `w${workerInfo.parallelIndex}`,
                        'state.sqlite3'));
  }, {scope: 'worker'}],

  // Auto, and before the page exists: a test that opens a browser must not find the last test's
  // pairs waiting for it on the relay.
  freshState: [async ({relayURL, stateDB}, use) => {
    clearSharedState(stateDB);
    await use();
  }, {auto: true}],

  baseURL: async ({relayURL}, use) => { await use(relayURL); },
});

module.exports = {test, expect: base.expect};
