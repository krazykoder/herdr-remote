// Browser tests run against a real relay backed by the fake herdr in tests/e2e/bin — the same
// fixture the Python E2Es use. Nothing here touches your live panes.
//
// This complements the node --test suites rather than replacing them. Those slice pure blocks out
// of index.html and are fast; they cannot open the app. Anything whose failure is "the page is
// broken" — a bad accessor, state surviving a pane switch, a layout that collapses at the wrong
// width — is only observable here.
const {defineConfig, devices} = require('@playwright/test');

const PORT = process.env.HERDR_PW_PORT || '8402';
const HERE = __dirname;

module.exports = defineConfig({
  testDir: './tests/e2e/browser',
  // The relay is one process holding one fake herdr's state; parallel workers would race on it.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // One project, a desktop viewport. A test that cares about a phone sets its own viewport —
    // a second project here would double every run for the few specs that need it.
    {name: 'desktop', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}}},
  ],
  webServer: {
    command: `${HERE}/.venv313/bin/python ${HERE}/relay/herdr_relay.py`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${HERE}/tests/e2e/bin:${process.env.PATH}`,   // fake ssh
      HERDR_BIN: `${HERE}/tests/e2e/bin/herdr`,            // fake herdr
      FAKE_LOG: `${HERE}/tests/e2e/fake_herdr.log`,
      HERDR_RELAY_PORT: PORT,
      HERDR_LAN_BIND: '127.0.0.1',
      HERDR_LAN_OPEN: '1',        // no token: the browser connects straight to its own origin
      HERDR_LOG_DIR: `${HERE}/tests/e2e/logs`,
      HERDR_ENABLE_TERMINAL: '1',
      HERDR_ENABLE_WRITE_EXT: '1',
      // No HERDR_REMOTES: one host keeps the fake's deliberate cross-host pane-ID collisions out
      // of the way, and the Projects fixture is not loaded because its entries name that host.
    },
  },
});
