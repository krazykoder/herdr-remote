#!/usr/bin/env python3
"""
Builds herdr-remote web distribution.
1. Inlines all <script src="src/*.js"> tags from web/index.html into a single self-contained web/dist/index.html.
2. Stamps the version from herdr-plugin.toml, and the build date, into the page's meta tags.
3. Copies required static assets (sw.js, manifest, icons, logo) to web/dist/.
"""

import datetime
import os
import re
import shutil

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT_DIR, "web")
SRC_DIR = os.path.join(WEB_DIR, "src")
DIST_DIR = os.path.join(WEB_DIR, "dist")


def plugin_version():
    """The version in herdr-plugin.toml, which is where this project writes it down once.

    Regex rather than tomllib, because this runs under whatever `python3` is on the path and
    tomllib is 3.11. The relay reads the same line the same way, so the number the page carries
    and the number the relay reports are the same number by construction.
    """
    with open(os.path.join(ROOT_DIR, "herdr-plugin.toml"), encoding="utf-8") as f:
        found = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
    if not found:
        raise ValueError("herdr-plugin.toml has no version line to stamp")
    return found.group(1)


def stamp_version(html, version, built):
    """Fill in the meta tags the unbuilt page carries as "dev".

    The date matters as much as the version between releases: two deploys of 0.5.0 a fortnight
    apart are not the same page, and "which one is on the phone" is exactly what gets asked.

    An empty version is refused rather than stamped: the page would then claim to be a build with
    no number, which reads as worse than the "dev" it replaced — that at least is true.
    """
    if not version:
        raise ValueError("refusing to stamp an empty version")
    html = re.sub(r'(<meta name="app-version" content=")[^"]*(")', r"\g<1>%s\g<2>" % version, html)
    return re.sub(r'(<meta name="app-built" content=")[^"]*(")', r"\g<1>%s\g<2>" % built, html)


def build():
    os.makedirs(DIST_DIR, exist_ok=True)
    index_path = os.path.join(WEB_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        src_html = f.read()

    # Find all individual script tags with src="src/..."
    inlined = []
    def replace_script(m):
        sf = m.group(1)
        sf_path = os.path.join(SRC_DIR, sf)
        if not os.path.isfile(sf_path):
            raise FileNotFoundError(f"Source file not found: {sf_path}")
        with open(sf_path, "r", encoding="utf-8") as f:
            code = f.read()
            code = re.sub(r'</script', r'<\\/script', code, flags=re.IGNORECASE)
            inlined.append(sf)
            return f"<script>\n{code}\n  </script>"

    dist_html = re.sub(r'<script\s+src="src/([^"]+)"></script>', replace_script, src_html)
    version = plugin_version()
    built = datetime.date.today().isoformat()
    dist_html = stamp_version(dist_html, version, built)
    dist_index_path = os.path.join(DIST_DIR, "index.html")
    with open(dist_index_path, "w", encoding="utf-8") as f:
        f.write(dist_html)

    # Copy static assets to dist/
    static_assets = [
        "sw.js",
        "manifest.webmanifest",
        "logo.svg",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
    ]
    for asset in static_assets:
        src_asset = os.path.join(WEB_DIR, asset)
        if os.path.isfile(src_asset):
            shutil.copy2(src_asset, os.path.join(DIST_DIR, asset))

    print(f"build: web/dist/index.html generated ({len(dist_html):,} bytes, "
          f"inlined {len(inlined)} modules, stamped {version} built {built}).")

if __name__ == "__main__":
    build()
