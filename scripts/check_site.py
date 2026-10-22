#!/usr/bin/env python3
"""Structural checks for the static site.

Guards the invariants this site depends on: valid nesting, a sane heading
outline, working internal links, images that reserve their space, and the
metadata search engines and social scrapers read. Standard library only, so
CI needs no dependencies.

Usage: python3 scripts/check_site.py [root]
Exits non-zero and prints every problem found.
"""

import hashlib
import json
import os
import re
import sys
import xml.dom.minidom
from html.parser import HTMLParser

SITE = "https://samsquaredsoftwares.com"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
# These pages are deliberately noindex and carry no canonical or social tags.
NOINDEX = {"404.html", "users.html"}
BARE_AMP = re.compile(r"&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);)")
# Cloudflare tells browsers to keep CSS and JS for 4 hours, so these fixed-name
# files carry ?v=<content hash> (scripts/stamp_assets.py). A missing or stale
# stamp means returning visitors get the old file after a deploy.
STAMPED = ("styles.css", "script.js", "book.js", "users.js", "assets/web3d/websites.js")


def asset_stamp(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:10]


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.open_tags = []
        self.nesting_errors = []
        self.headings = []
        self.ids = []
        self.links = []
        self.assets = []
        self.images = []
        self.mains = 0
        self._heading = None
        self._text = ""

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.append(a["id"])
        if tag == "a" and "href" in a:
            self.links.append(a["href"])
        if tag == "img":
            self.images.append(a)
            if "src" in a:
                self.assets.append(a["src"])
        if tag == "script" and "src" in a:
            self.assets.append(a["src"])
        if tag == "link" and a.get("href") and a.get("rel") != "canonical":
            self.assets.append(a["href"])
        if tag == "main":
            self.mains += 1
        if re.fullmatch(r"h[1-6]", tag):
            self._heading = int(tag[1])
            self._text = ""
        if tag not in VOID:
            self.open_tags.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if re.fullmatch(r"h[1-6]", tag) and self._heading:
            self.headings.append((self._heading, self._text.strip()[:60]))
            self._heading = None
        if not self.open_tags:
            self.nesting_errors.append("stray </%s>" % tag)
            return
        if self.open_tags[-1] != tag:
            self.nesting_errors.append("</%s> closes <%s>" % (tag, self.open_tags[-1]))
            if tag in self.open_tags:
                while self.open_tags and self.open_tags.pop() != tag:
                    pass
        else:
            self.open_tags.pop()

    def handle_data(self, data):
        if self._heading:
            self._text += data


def local_path(href):
    """Map an internal href to a repo-relative file, or None if external."""
    if href.startswith(("http://", "https://", "mailto:", "tel:", "#", "data:")):
        return None
    path = href.split("#")[0].split("?")[0]
    if not path:
        return None
    path = "index.html" if path in ("/", "") else path.lstrip("/")
    # GitHub Pages serves /book from book.html when nothing is called "book",
    # so the short form of a page link is a working link too.
    if (not os.path.exists(path) and "." not in os.path.basename(path)
            and os.path.exists(path + ".html")):
        return path + ".html"
    return path


def check_page(name, src, errors):
    def bad(msg):
        errors.append("%s: %s" % (name, msg))

    page = Page()
    page.feed(src)

    if page.open_tags:
        bad("unclosed tags: %s" % page.open_tags)
    for err in page.nesting_errors:
        bad(err)
    if page.mains != 1:
        bad("expected exactly one <main>, found %d" % page.mains)

    levels = [lv for lv, _ in page.headings]
    if levels.count(1) != 1:
        bad("expected exactly one <h1>, found %d" % levels.count(1))
    previous = 0
    for level, text in page.headings:
        if previous and level > previous + 1:
            bad("heading jumps h%d -> h%d at %r" % (previous, level, text))
        previous = level

    duplicates = sorted({i for i in page.ids if page.ids.count(i) > 1})
    if duplicates:
        bad("duplicate ids: %s" % duplicates)

    for img in page.images:
        src_attr = img.get("src", "?")
        if "alt" not in img:
            bad("<img src=%s> has no alt attribute" % src_attr)
        if "width" not in img or "height" not in img:
            bad("<img src=%s> has no width/height (causes layout shift)" % src_attr)

    for href in page.assets:
        path, _, query = href.split("#")[0].partition("?")
        stamped = path.lstrip("/")
        if stamped in STAMPED and os.path.exists(stamped):
            want = "v=" + asset_stamp(stamped)
            if query != want:
                bad("%s needs ?%s (run python3 scripts/stamp_assets.py)" % (path, want))

    for href in page.links + page.assets:
        target = local_path(href)
        if target is None:
            continue
        if not os.path.exists(target):
            bad("link target does not exist: %s" % href)
        elif "#" in href and href.split("#", 1)[1]:
            anchor = href.split("#", 1)[1]
            with open(target, encoding="utf-8") as fh:
                if ('id="%s"' % anchor) not in fh.read():
                    bad("anchor not found: %s" % href)

    for blob in re.findall(r'<script type="application/ld\+json">(.*?)</script>', src, re.S):
        try:
            json.loads(blob)
        except ValueError as exc:
            bad("invalid JSON-LD: %s" % exc)

    for value in re.findall(r'<meta (?:property|name)="[^"]+" content="([^"]*)"', src):
        if BARE_AMP.search(value):
            bad("unescaped & in meta content: %r" % value[:60])

    canonicals = re.findall(r'<link rel="canonical" href="([^"]*)"', src)
    if name in NOINDEX:
        if canonicals:
            bad("noindex page must not declare a canonical")
        if "noindex" not in src:
            bad("expected a noindex robots meta")
        return None

    if len(canonicals) != 1:
        bad("expected exactly one canonical, found %d" % len(canonicals))

    expected = SITE + ("/" if name == "index.html" else "/" + name)
    # A page may claim its short URL (/book for book.html), which Pages serves too.
    allowed = {expected}
    if name != "index.html":
        allowed.add(SITE + "/" + name[:-len(".html")])
    if canonicals and canonicals[0] not in allowed:
        bad("canonical is %s, expected %s" % (canonicals[0], expected))

    for tag in ("og:title", "og:description", "og:url", "og:image",
                "og:image:width", "og:image:height", "twitter:card", "twitter:image"):
        if ('="%s"' % tag) not in src:
            bad("missing %s" % tag)

    for image in re.findall(r'<meta (?:property="og:image"|name="twitter:image") content="([^"]*)"', src):
        if image.startswith(SITE):
            asset = image[len(SITE):].lstrip("/")
            if not os.path.exists(asset):
                bad("social image missing from repo: %s" % asset)

    return canonicals[0] if canonicals else None


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    os.chdir(root)
    errors = []
    pages = sorted(f for f in os.listdir(".") if f.endswith(".html"))
    if not pages:
        print("no HTML pages found in %s" % os.getcwd())
        return 1

    canonicals = {}
    for name in pages:
        with open(name, encoding="utf-8") as fh:
            canonical = check_page(name, fh.read(), errors)
        if canonical:
            canonicals.setdefault(canonical, []).append(name)

    for url, owners in sorted(canonicals.items()):
        if len(owners) > 1:
            errors.append("duplicate canonical %s claimed by %s" % (url, owners))

    if os.path.exists("sitemap.xml"):
        with open("sitemap.xml", encoding="utf-8") as fh:
            sitemap = fh.read()
        try:
            xml.dom.minidom.parseString(sitemap)
        except Exception as exc:
            errors.append("sitemap.xml is not valid XML: %s" % exc)
        listed = set(re.findall(r"<loc>([^<]+)</loc>", sitemap))
        for url in sorted(set(canonicals) - listed):
            errors.append("sitemap.xml is missing %s" % url)
        for url in sorted(listed - set(canonicals)):
            errors.append("sitemap.xml lists %s, which no page claims as canonical" % url)
    else:
        errors.append("sitemap.xml is missing")

    if os.path.exists("robots.txt"):
        with open("robots.txt", encoding="utf-8") as fh:
            if "sitemap.xml" not in fh.read().lower():
                errors.append("robots.txt does not point at the sitemap")
    else:
        errors.append("robots.txt is missing")

    if errors:
        print("Site checks FAILED (%d problem%s):\n" % (len(errors), "" if len(errors) == 1 else "s"))
        for err in errors:
            print("  - %s" % err)
        return 1

    print("Site checks passed: %d pages, %d canonical URLs." % (len(pages), len(canonicals)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
