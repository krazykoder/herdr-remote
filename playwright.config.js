// Browser tests run against a real relay backed by the fake herdr in tests/e2e/bin — the same
// fixture the Python E2Es use. Nothing here touches your live panes.
//
// This complements the node --test suites rather than replacing them. Those slice pure blocks out
// of index.html and are fast; they cannot open the app. Anything whose failure is "the page is
// broken" — a bad accessor, state surviving a pane switch, a layout that collapses at the wrong
// width — is only observable here.
const {defineConfig, devices} = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e/browser',
  // The relay is one process holding one fake herdr's state, so workers cannot share one. They do
  // not: tests/e2e/browser/fixtures.js starts a relay per worker on its own port and points
  // `baseURL` at it, which is what makes running them all at once safe.
  //
  // A quarter of the cores, not half. A worker is a browser, a Python relay polling on a timer, and
  // the fake herdr it shells out to on every poll — three processes each, and past a handful of
  // them the relays start missing HTTP requests under load (ERR_EMPTY_RESPONSE) and tests fail on
  // timing rather than on behaviour. Measured on the conversation suite: 5 workers took 2.0m with
  // one or two flakes every run, 2 workers took 1.8m clean. Oversubscribing bought nothing.
  workers: '25%',
  fullyParallel: true,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    // One project, a desktop viewport. A test that cares about a phone sets its own viewport —
    // a second project here would double every run for the few specs that need it.
    {name: 'desktop', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}}},
  ],
});
