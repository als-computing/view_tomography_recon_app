#!/usr/bin/env python3
"""
Scrape a curated set of SciVisColor (https://sciviscolor.org) transfer-function colormaps and emit
src/zarr-viewer/src/render/volume/sciviscolor-maps.ts.

Each map is written as a list of positioned RGB control points `[x, r, g, b]` (all in [0, 1]) — the
same shape the viewer samples for its colormap dropdown. Re-run when you want to change the set:

    python3 scripts/scrape-sciviscolor.py

Requires network access. Pure stdlib (urllib + ElementTree); no third-party deps.
"""
import os, re, sys, urllib.request, xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src/zarr-viewer/src/render/volume/sciviscolor-maps.ts")
BASE = "https://sciviscolor.org"

# Category index pages (+ per-hue linear subpages) whose HTML lists the .xml download links.
CATEGORY_PAGES = ["/colormaps/divergent/", "/colormaps/wave/"]
LINEAR_SUBPAGES = [
    "purples", "blues", "turquoise", "greens", "yellows", "oranges", "reds", "browns",
]

# Curated basename -> clean display name (basename = the .xml filename stem on the site).
SELECT = [
    ("div1-blue-orange-div", "Blue-Orange (div)"),
    ("div2-gray-gold", "Gray-Gold (div)"),
    ("div3-green-brown-div", "Green-Brown (div)"),
    ("div4-turqoise-olive", "Turquoise-Olive (div)"),
    ("div5-asym-orange-blue", "Orange-Blue asym (div)"),
    ("br4div", "Blue-Red 4 (div)"),
    ("d_blgr3", "Blue-Green (div)"),
    ("w_ymiddle1", "Yellow-center (div)"),
    ("tr4", "Teal-Red (div)"),
    ("dasy_grbr1", "Green-Brown asym (div)"),
    ("speed_yel25e", "Speed Yellow (div)"),
    ("w5m4", "White-center 5 (div)"),
    ("bruce2", "Bruce (div)"),
    ("c_blgr1", "Blue-Green cool (div)"),
    ("d_seteq2", "Muted Set (wave)"),
    ("3wmutedset", "3-Wave Muted (wave)"),
    ("4wlteqcool", "4-Wave Cool (wave)"),
    ("5wlteqcool", "5-Wave Cool (wave)"),
    ("high2ml", "Highlight 2 (wave)"),
    ("high3", "Highlight 3 (wave)"),
    ("high4", "Highlight 4 (wave)"),
    ("high5", "Highlight 5 (wave)"),
    ("hier2p", "Hierarchy 2 (wave)"),
    ("hier1p", "Hierarchy 1 (wave)"),
    ("hier4w", "Hierarchy 4 (wave)"),
    ("hier5", "Hierarchy 5 (wave)"),
    ("1-purp2", "Purple (lin)"),
    ("01blue-gblue", "Blue (lin)"),
    ("1-l_turqsat1", "Turquoise (lin)"),
    ("01green-gr1214b", "Green (lin)"),
    ("1-yel_peach_br", "Yellow-Peach (lin)"),
    ("1-l_orangesat1", "Orange (lin)"),
    ("1-rpinky", "Red-Pink (lin)"),
    ("01brown-sable", "Brown (lin)"),
    ("10-yg1", "Yellow-Green (lin)"),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=25).read()


def build_catalog():
    """basename -> /media/... path, scraped from the category + linear-hue pages."""
    catalog = {}
    pages = list(CATEGORY_PAGES) + [f"/colormaps/linear/{s}/" for s in LINEAR_SUBPAGES]
    for page in pages:
        try:
            html = get(BASE + page).decode("utf-8", "replace")
        except Exception as e:
            print("page ERR", page, e, file=sys.stderr)
            continue
        for path in re.findall(r"/media/filer_public/[^\"']+\.xml", html):
            base = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            catalog.setdefault(base, path)
    return catalog


def parse_points(data):
    root = ET.fromstring(data)
    cm = root.find(".//ColorMap") or (root if root.tag == "ColorMap" else None)
    if cm is None:
        return None
    pts = []
    for p in cm.findall("Point"):
        try:
            pts.append((float(p.get("x")), float(p.get("r")), float(p.get("g")), float(p.get("b"))))
        except (TypeError, ValueError):
            continue
    if len(pts) < 2:
        return None
    xs = [p[0] for p in pts]
    lo, span = min(xs), (max(xs) - min(xs)) or 1.0
    clamp = lambda v: round(min(1.0, max(0.0, v)), 4)
    return [(clamp((x - lo) / span), clamp(r), clamp(g), clamp(b)) for (x, r, g, b) in pts]


def main():
    catalog = build_catalog()
    maps = []
    for base, name in SELECT:
        path = catalog.get(base)
        if not path:
            print("MISSING", base, file=sys.stderr)
            continue
        try:
            pts = parse_points(get(BASE + path))
        except Exception as e:
            print("ERR", base, e, file=sys.stderr)
            continue
        if not pts:
            print("NOPTS", base, file=sys.stderr)
            continue
        maps.append((name, pts))
        print("ok", base, len(pts), "pts", file=sys.stderr)

    out = ['/**',
           ' * SciVisColor transfer-function colormaps (scraped from https://sciviscolor.org).',
           ' *',
           ' * Each entry is a list of positioned RGB control points `[x, r, g, b]` (x, r, g, b in [0,1]).',
           ' * Generated — do not edit by hand; re-run scripts/scrape-sciviscolor.py to refresh.',
           ' *',
           ' * @packageDocumentation',
           ' */',
           '',
           '/** A positioned RGB control point: `[x, r, g, b]`, all in [0, 1]. */',
           'export type ColorStop = readonly [number, number, number, number];',
           '',
           'export const SCIVIS_MAPS: Record<string, readonly ColorStop[]> = {']
    for name, pts in maps:
        body = ", ".join("[%g, %g, %g, %g]" % p for p in pts)
        out.append('  "%s": [%s],' % (name.replace('"', '\\"'), body))
    out.append("};")
    out.append("")
    with open(OUT, "w") as f:
        f.write("\n".join(out))
    print("WROTE", OUT, "with", len(maps), "maps", file=sys.stderr)


if __name__ == "__main__":
    main()
