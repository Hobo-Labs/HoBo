"""Write the Unicode table that pins-archive-fold.test.ts checks the reader's name rules against.

    python3 -I scripts/test/support/unicode-casefold.py UCD_DIR > scripts/test/support/unicode-casefold.json

UCD_DIR holds DerivedCoreProperties.txt and UnicodeData.txt from
https://www.unicode.org/Public/15.1.0/ucd/, the same Unicode version as the Python
running this (3.13: 15.1.0); DerivedCoreProperties.txt's version is checked.

For every assigned code point of the Unicode version Python ships:
- "fold": [code point, NFD(casefold(NFD(c)))] where that differs from NFD(c): the
  canonical caseless match of Unicode 3.13 (D145), which Linux casefold directories and
  APFS apply;
- "upcase": [code point, its simple uppercase] for every BMP code point that has one
  (UnicodeData.txt field 12): the mapping NTFS's $UpCase table holds, applied to each
  UTF-16 unit of a name with no normalisation;
- "unassigned": the BMP code points unassigned in this version, as inclusive ranges,
  so a test can tell a code point this version leaves uncased from one it does not know;
- "ignorable": Default_Ignorable_Code_Point from DerivedCoreProperties.txt, as
  inclusive [first, last] ranges, adjacent ranges merged.
"""
import json
import os
import sys
import unicodedata as u

UCD = sys.argv[1]


def ucd_lines(name):
    with open(os.path.join(UCD, name), encoding="utf-8") as text:
        first = text.readline()
        if u.unidata_version not in first:
            sys.exit(f"{name} is not Unicode {u.unidata_version}: {first.strip()}")
        for line in text:
            line = line.split("#", 1)[0].strip()
            if line:
                yield [field.strip() for field in line.split(";")]


def ranges(prop):
    found = []
    for fields in ucd_lines("DerivedCoreProperties.txt"):
        if fields[1:] != [prop]:
            continue
        points = fields[0]
        first, _, last = points.partition("..")
        found.append([int(first, 16), int(last or first, 16)])
    found.sort()
    merged = []
    for first, last in found:
        if merged and merged[-1][1] + 1 == first:
            merged[-1][1] = last
        else:
            merged.append([first, last])
    return merged


def key(text):
    return u.normalize("NFD", u.normalize("NFD", text).casefold())


def simple_uppercase():
    mapping = {}
    with open(os.path.join(UCD, "UnicodeData.txt"), encoding="utf-8") as text:
        for line in text:
            fields = line.split(";")
            if fields[12]:
                mapping[int(fields[0], 16)] = int(fields[12], 16)
    return mapping


def merge(points):
    merged = []
    for point in points:
        if merged and merged[-1][1] + 1 == point:
            merged[-1][1] = point
        else:
            merged.append([point, point])
    return merged


SIMPLE_UPPER = simple_uppercase()
fold, upcase, unassigned = [], [], []
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    c = chr(cp)
    if u.category(c) == "Cn":
        if cp <= 0xFFFF:
            unassigned.append(cp)
        continue
    k = key(c)
    if k != u.normalize("NFD", c):
        fold.append([cp, k])
    if cp <= 0xFFFF and cp in SIMPLE_UPPER:
        upcase.append([cp, SIMPLE_UPPER[cp]])
json.dump(
    {
        "unicode": u.unidata_version,
        "fold": fold,
        "upcase": upcase,
        "unassigned": merge(unassigned),
        "ignorable": ranges("Default_Ignorable_Code_Point"),
    },
    sys.stdout,
    ensure_ascii=True,
    separators=(",", ":"),
)
sys.stdout.write("\n")
