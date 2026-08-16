// What iOS needs before it will offer Add to Home Screen — and therefore before Web Push can
// exist at all on a phone. A home-screen web app is the only place iOS delivers push, and it will
// only install a page whose manifest and icon it can actually fetch.
//
// The relay serves these from an allowlist, so a file added to web/ without a route 404s in
// exactly the deployment where it matters most. That is what this file watches.
//
//   npx playwright test
const {test, expect} = require('./fixtures');

test('the relay serves a fetchable manifest naming icons that exist', async ({request}) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/manifest+json');

  const manifest = JSON.parse(await res.text());
  // display:standalone is the property that makes the installed app chromeless — and on iOS, a
  // web app is what may hold a push subscription. A bookmark may not.
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);

  for (const icon of manifest.icons) {
    const img = await request.get('/' + icon.src);
    expect(img.status(), `${icon.src} is named by the manifest`).toBe(200);
    expect(img.headers()['content-type']).toBe('image/png');
  }
});

test('the page links the manifest and the icon iOS actually reads', async ({page}) => {
  await page.goto('/');
  // iOS takes the home-screen icon from apple-touch-icon and ignores the manifest's icons array.
  // That icon is also the one drawn on a push notification, so a missing link is a blank badge.
  const manifest = page.locator('link[rel="manifest"]');
  await expect(manifest).toHaveAttribute('href', 'manifest.webmanifest');
  const touch = page.locator('link[rel="apple-touch-icon"]');
  await expect(touch).toHaveCount(1);

  const href = await touch.getAttribute('href');
  const res = await page.request.get('/' + href);
  expect(res.status()).toBe(200);
});

test('the service worker still has its own route and scope header', async ({request}) => {
  // Folded into the static table with the icons; it needs a header none of them do.
  const res = await request.get('/sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['service-worker-allowed']).toBe('/');
  expect(res.headers()['content-type']).toContain('javascript');
});

test('a path outside the allowlist is not served', async ({request}) => {
  // The handler answers the tunnel as well as the LAN, so "serve web/ by name" must stay a list.
  for (const path of ['/deploy.sh', '/make-icons.py', '/../relay/herdr_relay.py']) {
    const res = await request.get(path);
    expect(res.status(), `${path} is reachable`).toBe(404);
  }
});
