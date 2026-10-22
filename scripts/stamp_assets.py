#!/usr/bin/env python3
"""Stamp the site's CSS and JS links with a content hash.

Cloudflare tells browsers to keep CSS and JS for 4 hours. Without a version in
the URL, anyone who visited in that window keeps the old file after a deploy,
so new pages render with old styles. Each link gets ?v=<first 10 hex of the
file's SHA-256>, so a changed file gets a new URL and is fetched fresh.

Run after editing styles.css, script.js, book.js or the web3d bundle:
    python3 scripts/stamp_assets.py
scripts/check_site.py fails in CI when a stamp is missing or stale.
"""

import hashlib
import os
import re
import sys

# Files whose names never change, so they need a version in the URL.
# (The web3d scene chunk already has a content hash in its file name.)
STAMPED = ["styles.css", "script.js", "book.js", "assets/web3d/websites.js"]


def stamp(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:10]


def pattern(asset):
    # href="/styles.css" or src="/script.js", with or without an old ?v=
    return re.compile(r'((?:href|src)="/' + re.escape(asset) + r')(?:\?v=[0-9a-f]*)?"')


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    os.chdir(root)
    stamps = {a: stamp(a) for a in STAMPED if os.path.exists(a)}
    changed = 0
    for name in sorted(f for f in os.listdir(".") if f.endswith(".html")):
        with open(name, encoding="utf-8") as fh:
            src = fh.read()
        out = src
        for asset, v in stamps.items():
            out = pattern(asset).sub(lambda m: '%s?v=%s"' % (m.group(1), v), out)
        if out != src:
            with open(name, "w", encoding="utf-8") as fh:
                fh.write(out)
            changed += 1
            print("stamped %s" % name)
    print("%d page%s updated; stamps: %s" % (changed, "" if changed == 1 else "s",
                                              ", ".join("%s=%s" % kv for kv in stamps.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
