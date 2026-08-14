#!/usr/bin/env python3
"""
Builds herdr-remote web distribution.
1. Inlines all <script src="src/*.js"> tags from web/index.html into a single self-contained web/dist/index.html.
2. Copies required static assets (sw.js, manifest, icons, logo) to web/dist/.
"""

import os
import re
import shutil

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT_DIR, "web")
SRC_DIR = os.path.join(WEB_DIR, "src")
DIST_DIR = os.path.join(WEB_DIR, "dist")

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

    print(f"build: web/dist/index.html generated ({len(dist_html):,} bytes, inlined {len(inlined)} modules).")

if __name__ == "__main__":
    build()
