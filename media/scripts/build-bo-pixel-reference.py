# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "numpy>=1.26"]
# ///
"""Build Bo's pixel reference sheet — a model sheet, not an animation export.

No generation model is involved. The bodies come from the approved art in
`site/public/parallax/` (deterministic downscale-and-quantize, so the identity
— bindle arm, eye spacing, fur silhouette — is inherited rather than re-drawn),
and every pose beyond the turnaround is deterministic pixel surgery on those
bases: the eye region is repainted with the pupil placed per expression, legs
are erased and re-posed, posture comes from squash/stretch applied at source
resolution, and the free arm is drawn as the same one-stroke-one-dot rubber
hose the sheets use. The bindle arm never changes: it holds the pole in every
cell.

The rear view is the front stand mirrored with its enclosed whites inked out;
front-to-back mirroring keeps the bindle on the same anatomical shoulder,
unlike the forbidden east-west mirror (see `site/public/parallax/README.md`).

Outputs (both committed, both reproducible from this script alone):
  media/public/reference/bo-pixel-reference.png  - labeled model sheet, 4x
  media/public/reference/bo-pixel-sprites.png    - native 1x sprites, 56x56 cells

Run from the repo root:  uv run media/scripts/build-bo-pixel-reference.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
PARALLAX = ROOT / "site" / "public" / "parallax"
OUT_DIR = ROOT / "media" / "public" / "reference"
FONT_PATH = (
    ROOT / "packages" / "pixel-village" / "assets" / "fonts" / "kenney" / "KenneyPixel.ttf"
)

# Pixel grid: sprites are 48px tall, flat black/white/transparent, plus a 1px rim.
TARGET_H = 48
ALPHA_THR = 0.30  # box-averaged coverage below this drops the pixel (keeps 1px limbs)
# Source grey is trimodal: ink 0-64, the pole's light greys 96-160, paper 192-255.
# A pixel is white by *coverage* of light source pixels, not by cell mean — the
# mean dilutes a thin white pole with its own black outline and shreds it.
WHITE_SRC_THR = 96  # source grey at or above this counts as light
WHITE_COV_THR = 0.35  # fraction of the cell that must be light to quantize white

BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)

# HoBo Pixel palette (packages/pixel-village/DESIGN.md) for the sheet chrome only;
# the sprites themselves stay flat black and white, per the character lock.
PAPER = (244, 241, 232)
OUTLINE = (63, 38, 49)
CELL_BG = (139, 155, 180)
MUTE = (82, 96, 124)

SCALE = 4  # presentation upscale, nearest-neighbour


# ---------------------------------------------------------------- quantization


def load_frames(path: Path, cols: int, rows: int, fw: int, fh: int) -> list[np.ndarray]:
    arr = np.asarray(Image.open(path).convert("LA"))
    return [
        arr[r * fh : (r + 1) * fh, c * fw : (c + 1) * fw].copy()
        for r in range(rows)
        for c in range(cols)
    ]


def strip_ground_shadow(frame: np.ndarray) -> np.ndarray:
    """The east walk sheet carries a pale ground ellipse under the feet; reference
    frame hygiene says no ground shadow, so drop light pixels in the feet band."""
    f = frame.copy()
    band = int(f.shape[0] * 0.90)
    light = f[band:, :, 0] > 140
    f[band:, :, 1][light] = 0
    return f


def pixelize(
    frame: np.ndarray, target_h: int = TARGET_H, width_scale: float = 1.0
) -> np.ndarray:
    """Downscale onto the pixel grid and quantize to black/white/transparent.

    `target_h`/`width_scale` let a pose squash or stretch the body at source
    resolution, where the transform is smooth, instead of shearing quantized
    pixels."""
    grey = frame[:, :, 0].astype(np.float64)
    alpha = frame[:, :, 1].astype(np.float64) / 255.0
    h, w = alpha.shape
    tw = max(1, round(w * target_h / h * width_scale))

    def box(mask: np.ndarray) -> np.ndarray:
        img = Image.fromarray((mask * 255).astype(np.uint8)).resize((tw, target_h), Image.BOX)
        return np.asarray(img).astype(np.float64) / 255.0

    a_ds = box(alpha)
    w_cov = box((grey >= WHITE_SRC_THR) & (alpha > 0.5))
    opaque = a_ds >= ALPHA_THR
    white = opaque & (w_cov >= WHITE_COV_THR)
    out = np.zeros((target_h, tw, 4), np.uint8)
    out[opaque & ~white] = BLACK
    out[white] = WHITE
    return clean(despeckle(out))


def despeckle(px: np.ndarray) -> np.ndarray:
    """Remove opaque pixels with no 4-connected opaque neighbour (dust, not tufts)."""
    a = px[:, :, 3] > 0
    padded = np.pad(a, 1)
    neighbours = (
        padded[:-2, 1:-1].astype(int)
        + padded[2:, 1:-1]
        + padded[1:-1, :-2]
        + padded[1:-1, 2:]
    )
    px[a & (neighbours == 0)] = 0
    return px


def clean(px: np.ndarray) -> np.ndarray:
    """Two targeted repairs, both conservative by design.

    - Drop white fuzz: white components under 4px that touch transparency are
      quantization noise off the silhouette edge, never drawn detail. Interior
      white stays untouched however small — the free arm ends in a deliberate
      one-dot hand, and the stand blink's inner sliver is 1-2px.
    - Fill sack pinholes: black components up to 3px enclosed entirely by
      *exterior* white (white that reaches the silhouette edge — the bundle and
      pole, never the eyes) are the sack's own outline averaging through; ink
      them white. Pupils live inside enclosed white, so they cannot match.
    """
    opaque = px[:, :, 3] > 0
    white = opaque & (px[:, :, 0] > 128)
    transparent = ~opaque
    pad_t = np.pad(transparent, 1)
    near_edge = pad_t[:-2, 1:-1] | pad_t[2:, 1:-1] | pad_t[1:-1, :-2] | pad_t[1:-1, 2:]

    w_labels = components(white)
    exterior = {
        lab
        for lab in range(1, w_labels.max() + 1)
        if ((w_labels == lab) & near_edge).any()
    }
    for lab in range(1, w_labels.max() + 1):
        comp = w_labels == lab
        if lab in exterior and comp.sum() < 4:
            px[comp] = 0  # edge fuzz off the silhouette

    white = (px[:, :, 3] > 0) & (px[:, :, 0] > 128)
    w_labels = components(white)
    black = (px[:, :, 3] > 0) & ~white
    b_labels = components(black)
    for lab in range(1, b_labels.max() + 1):
        comp = b_labels == lab
        if comp.sum() > 3:
            continue
        ys, xs = np.nonzero(comp)
        ring_labels = set()
        enclosed = True
        for y, x in zip(ys, xs):
            for ny, nx_ in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if not (0 <= ny < comp.shape[0] and 0 <= nx_ < comp.shape[1]):
                    enclosed = False
                    break
                if comp[ny, nx_]:
                    continue
                if not white[ny, nx_]:
                    enclosed = False
                    break
                ring_labels.add(int(w_labels[ny, nx_]))
            if not enclosed:
                break
        if enclosed and ring_labels and ring_labels <= exterior:
            px[comp] = WHITE
    return px


def add_rim(px: np.ndarray) -> np.ndarray:
    """1px dual rim so the sprite reads on any ground: white against the black
    fur (he is solid ink and vanishes on dark otherwise), black against exposed
    white (so the bundle keeps an outline on paper). 8-neighbour: a 4-neighbour
    rim breaks into dashes along the diagonal fur edges, which reads as noise
    on a dark ground rather than a contour."""
    h, w = px.shape[:2]
    out = np.zeros((h + 2, w + 2, 4), np.uint8)
    out[1:-1, 1:-1] = px
    opaque = out[:, :, 3] > 0
    black = opaque & (out[:, :, 0] < 128)
    white = opaque & ~black

    def spread(mask: np.ndarray) -> np.ndarray:
        p = np.pad(mask, 1)
        return (
            p[:-2, :-2] | p[:-2, 1:-1] | p[:-2, 2:]
            | p[1:-1, :-2] | p[1:-1, 2:]
            | p[2:, :-2] | p[2:, 1:-1] | p[2:, 2:]
        )

    rim_white = ~opaque & spread(black)
    rim_black = ~opaque & spread(white) & ~rim_white
    out[rim_white] = WHITE
    out[rim_black] = BLACK
    return out


def components(mask: np.ndarray) -> np.ndarray:
    """4-connected component labels for a boolean mask (tiny BFS, no scipy)."""
    labels = np.zeros(mask.shape, np.int32)
    nxt = 0
    for sy, sx in zip(*np.nonzero(mask & (labels == 0))):
        if labels[sy, sx]:
            continue
        nxt += 1
        stack = [(int(sy), int(sx))]
        labels[sy, sx] = nxt
        while stack:
            y, x = stack.pop()
            for ny, nx_ in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if (
                    0 <= ny < mask.shape[0]
                    and 0 <= nx_ < mask.shape[1]
                    and mask[ny, nx_]
                    and not labels[ny, nx_]
                ):
                    labels[ny, nx_] = nxt
                    stack.append((ny, nx_))
    return labels


# ------------------------------------------------------------- pixel anatomy


def eye_regions(px: np.ndarray) -> list[dict]:
    """Locate the two eyes: enclosed white components in the upper two-thirds,
    roundish, 12-80px. Each region is the white ring plus the pupil it encloses,
    so a repaint can move the pupil without leaving residue."""
    h, w = px.shape[:2]
    opaque = px[:, :, 3] > 0
    white = opaque & (px[:, :, 0] > 128)
    transparent = ~opaque
    pad_t = np.pad(transparent, 1)
    near_edge = pad_t[:-2, 1:-1] | pad_t[2:, 1:-1] | pad_t[1:-1, :-2] | pad_t[1:-1, 2:]
    labels = components(white)
    cands = []
    for lab in range(1, labels.max() + 1):
        comp = labels == lab
        if (comp & near_edge).any():
            continue  # sack, not an eye
        n = int(comp.sum())
        if not 12 <= n <= 80:
            continue
        ys, xs = np.nonzero(comp)
        bh, bw = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
        if ys.mean() > h * 0.66 or not 0.5 <= bh / bw <= 2.0:
            continue
        cands.append((n, comp, ys, xs))
    cands.sort(key=lambda c: -c[0])
    eyes = sorted(cands[:2], key=lambda c: c[3].mean())
    out = []
    black = opaque & ~white
    b_labels = components(black)
    for _, comp, ys, xs in eyes:
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        region = comp.copy()
        pupil = np.zeros_like(comp)
        for lab in range(1, b_labels.max() + 1):
            bcomp = b_labels == lab
            bys, bxs = np.nonzero(bcomp)
            if len(bys) > 40:
                continue
            if bys.min() >= y0 and bys.max() <= y1 and bxs.min() >= x0 and bxs.max() <= x1:
                region |= bcomp
                pupil |= bcomp
        out.append({"region": region, "pupil": pupil})
    return out


def set_gaze(px: np.ndarray, dx: int, dy: int, pupil_size: tuple[int, int] | None = None) -> np.ndarray:
    """Repaint both eye regions white and place the pupil offset from center,
    nudged back until it fits fully inside the eye."""
    px = px.copy()
    for eye in eye_regions(px):
        region, pupil = eye["region"], eye["pupil"]
        pys, pxs = np.nonzero(pupil if pupil.any() else region)
        ph = pupil_size[0] if pupil_size else max(2, pys.max() - pys.min() + 1)
        pw = pupil_size[1] if pupil_size else max(2, pxs.max() - pxs.min() + 1)
        rys, rxs = np.nonzero(region)
        cy, cx = int(rys.mean()), int(rxs.mean())
        px[region] = WHITE
        ty, tx = cy + dy, cx + dx
        for _ in range(8):
            ys = slice(ty - ph // 2, ty - ph // 2 + ph)
            xs = slice(tx - pw // 2, tx - pw // 2 + pw)
            block = np.zeros_like(region)
            block[ys, xs] = True
            if (block & ~region).sum() == 0:
                break
            ty += (cy > ty) - (cy < ty)
            tx += (cx > tx) - (cx < tx)
            if (ty, tx) == (cy, cx):
                break
        px[ty - ph // 2 : ty - ph // 2 + ph, tx - pw // 2 : tx - pw // 2 + pw] = BLACK
        keep = np.zeros_like(region)
        keep[ty - ph // 2 : ty - ph // 2 + ph, tx - pw // 2 : tx - pw // 2 + pw] = True
        px[keep & ~region] = BLACK  # clipped by the nudge loop; belt and braces
    return px


def wide_eyes(px: np.ndarray) -> np.ndarray:
    """Startled: grow each eye 1px into the surrounding fur (but never toward
    the other eye — closing the gap merges them into goggles), then draw a
    small centered pupil directly. No re-detection after growth: the grown
    whites can exceed the eye-finder's size cap."""
    px = px.copy()
    body_black = (px[:, :, 3] > 0) & (px[:, :, 0] < 128)
    eyes = eye_regions(px)
    if len(eyes) == 2:
        c0 = int(np.nonzero(eyes[0]["region"])[1].mean())
        c1 = int(np.nonzero(eyes[1]["region"])[1].mean())
        mid = (c0 + c1) // 2
        keep_out = slice(mid - 1, mid + 2)
    else:
        keep_out = slice(0, 0)
    for eye in eyes:
        region = eye["region"]
        p = np.pad(region, 1)
        grown = p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | p[1:-1, 1:-1]
        grown[:, keep_out] = region[:, keep_out]
        grow_into = grown & body_black & ~region
        full = region | grow_into
        px[full] = WHITE
        ys, xs = np.nonzero(full)
        cy, cx = round(ys.mean()), round(xs.mean())
        px[cy - 1 : cy + 1, cx - 1 : cx + 1] = BLACK
    return px


def lidded_eyes(px: np.ndarray) -> np.ndarray:
    """Sleepy: ink the upper 55% of each eye region as a heavy lid, pupil low."""
    px = set_gaze(px, 0, 1)
    for eye in eye_regions(px):
        region = eye["region"]
        ys = np.nonzero(region.any(axis=1))[0]
        lid_to = ys.min() + int(len(ys) * 0.55)
        lid = region.copy()
        lid[lid_to:, :] = False
        px[lid] = BLACK
    return px


def body_bottom(px: np.ndarray) -> int:
    """Last row where the ink is body-wide rather than leg-thin."""
    black = (px[:, :, 3] > 0) & (px[:, :, 0] < 128)
    widths = black.sum(axis=1)
    body_rows = np.nonzero(widths >= 12)[0]
    return int(body_rows[-1])


def erase_legs(px: np.ndarray) -> tuple[np.ndarray, int]:
    px = px.copy()
    bottom = body_bottom(px)
    px[bottom + 1 :, :] = 0
    return px, bottom


def draw_leg(px: np.ndarray, x: int, y0: int, length: int, foot_dx: int) -> None:
    px[y0 : y0 + length, x : x + 2] = BLACK
    fy = y0 + length
    fx0 = x + (foot_dx if foot_dx < 0 else 0)
    px[fy : fy + 2, fx0 : fx0 + 4] = BLACK


def black_extent(px: np.ndarray, row: int) -> tuple[int, int]:
    black = (px[:, :, 3] > 0) & (px[:, :, 0] < 128)
    cols = np.nonzero(black[row])[0]
    return int(cols[0]), int(cols[-1])


def draw_stroke(px: np.ndarray, pts: list[tuple[int, int]], thickness: int = 2) -> None:
    """White rubber-hose stroke through the given (y, x) points."""
    for (y0, x0), (y1, x1) in zip(pts, pts[1:]):
        n = max(abs(y1 - y0), abs(x1 - x0), 1)
        for i in range(n + 1):
            y = round(y0 + (y1 - y0) * i / n)
            x = round(x0 + (x1 - x0) * i / n)
            px[y : y + thickness, x : x + thickness] = WHITE


def pad_canvas(px: np.ndarray, left: int = 0, right: int = 0, top: int = 0, bottom: int = 0) -> np.ndarray:
    h, w = px.shape[:2]
    out = np.zeros((h + top + bottom, w + left + right, 4), np.uint8)
    out[top : top + h, left : left + w] = px
    return out


# --------------------------------------------------------------------- poses


def pose_sit(front: np.ndarray) -> np.ndarray:
    """Grounded: legs gone, feet poking out sideways at the base."""
    px, bottom = erase_legs(front)
    x0, x1 = black_extent(px, bottom - 2)
    px[bottom - 1 : bottom + 1, max(0, x0 - 3) : x0 + 1] = BLACK
    px[bottom - 1 : bottom + 1, x1 : min(px.shape[1], x1 + 4)] = BLACK
    return px


def pose_crouch(stand_src: np.ndarray) -> np.ndarray:
    """Duck: body squashed at source resolution, legs bent short."""
    px = pixelize(stand_src, target_h=int(TARGET_H * 0.82), width_scale=1.12 / 0.82)
    px, bottom = erase_legs(px)
    px = pad_canvas(px, bottom=4)
    x0, x1 = black_extent(px, bottom - 1)
    mid = (x0 + x1) // 2
    draw_leg(px, mid - 7, bottom + 1, 2, -2)
    draw_leg(px, mid + 5, bottom + 1, 2, 2)
    return px


def pose_hop(idle_apex: np.ndarray) -> np.ndarray:
    """The idle strip's real airborne frame — drawn art, feet tucked."""
    return pixelize(idle_apex)


def eye_span(px: np.ndarray) -> tuple[int, int]:
    """(top, bottom) rows of the eye whites, for anchoring limbs off the face."""
    rows = [np.nonzero(e["region"].any(axis=1))[0] for e in eye_regions(px)]
    return int(min(r.min() for r in rows)), int(max(r.max() for r in rows))


def pose_wave(front: np.ndarray) -> np.ndarray:
    """Free arm raised beside the head in a wave — a 1px rubber-hose stroke
    ending in the one-dot hand, anchored at the shoulder (below the eyes, at
    the body's edge), never out of the head. The bindle arm keeps the pole;
    the old free-arm dot at the right edge is erased so he does not grow a
    third arm."""
    px = front.copy()
    h, w = px.shape[:2]
    opaque = px[:, :, 3] > 0
    white = opaque & (px[:, :, 0] > 128)
    labels = components(white)
    for lab in range(1, labels.max() + 1):
        comp = labels == lab
        ys, xs = np.nonzero(comp)
        if comp.sum() <= 8 and xs.min() >= w - 8:
            px[comp] = BLACK  # old free-arm marks, absorbed into the fur
    eye_top, eye_bottom = eye_span(px)
    px = pad_canvas(px, right=7, top=2)
    eye_top += 2
    eye_bottom += 2
    shoulder_y = eye_bottom + 4
    _, edge = black_extent(px, shoulder_y)
    draw_stroke(
        px,
        [
            (shoulder_y, edge - 1),
            (eye_bottom, edge + 3),
            (eye_top + 1, edge + 4),
        ],
        thickness=1,
    )
    px[eye_top - 2 : eye_top, edge + 4 : edge + 6] = WHITE  # the one-dot hand
    return px


def pose_point_east(east: np.ndarray) -> np.ndarray:
    """East profile, free arm pointing ahead (screen-right) — anchored below
    the eyes at the body's leading edge, not through the face."""
    px = pad_canvas(east, right=9)
    eye_top, eye_bottom = eye_span(px)
    arm_y = eye_bottom + 5
    _, edge = black_extent(px, arm_y)
    draw_stroke(px, [(arm_y, edge - 3), (arm_y - 1, edge + 4)], thickness=1)
    px[arm_y - 2 : arm_y, edge + 5 : edge + 7] = WHITE  # the one-dot hand
    return px


def pose_startled(stand_src: np.ndarray) -> np.ndarray:
    """Stretched upright with wide eyes."""
    px = pixelize(stand_src, target_h=int(TARGET_H * 1.06), width_scale=0.94 / 1.06)
    return wide_eyes(px)


def pose_sleepy(stand_src: np.ndarray) -> np.ndarray:
    """Slumped with heavy lids."""
    px = pixelize(stand_src, target_h=int(TARGET_H * 0.92), width_scale=1.06 / 0.92)
    return lidded_eyes(px)


def derive_north(front: np.ndarray) -> np.ndarray:
    """Rear view: mirror the front stand (front-to-back keeps the bindle on the
    same anatomical shoulder), then hide everything a back view cannot see —
    white regions fully enclosed by ink (eyes, and the pole where it crosses in
    front of the body). White that touches the silhouette edge (bundle, pole
    above the shoulder) stays."""
    px = front[:, ::-1].copy()
    white = (px[:, :, 3] > 0) & (px[:, :, 0] > 128)
    transparent = px[:, :, 3] == 0
    labels = components(white)
    pad_t = np.pad(transparent, 1)
    near_edge = (
        pad_t[:-2, 1:-1] | pad_t[2:, 1:-1] | pad_t[1:-1, :-2] | pad_t[1:-1, 2:]
    )
    for lab in range(1, labels.max() + 1):
        comp = labels == lab
        if not (comp & near_edge).any():  # fully enclosed by ink -> occluded from behind
            px[comp] = BLACK
    return px


def narrowest_stance(frames: list[np.ndarray], indices: range) -> int:
    """Pick the neutral standing frame the way the site README did: measure the
    opaque column spread of the feet band and take the minimum."""
    best, best_w = indices[0], 10**9
    for i in indices:
        f = frames[i]
        band = f[int(f.shape[0] * 0.85) :, :, 1] > 100
        cols = np.nonzero(band.any(axis=0))[0]
        w = int(cols[-1] - cols[0]) if cols.size else 10**9
        if w < best_w:
            best, best_w = i, w
    return best


def baseline(px: np.ndarray) -> int:
    rows = np.nonzero(px[:, :, 3].any(axis=1))[0]
    return int(rows[-1]) if rows.size else px.shape[0] - 1


# ------------------------------------------------------------------ assembly


def main() -> None:
    walk_e = [strip_ground_shadow(f) for f in load_frames(PARALLAX / "bo-walk.png", 6, 6, 160, 157)]
    walk_w = [strip_ground_shadow(f) for f in load_frames(PARALLAX / "bo-walk-left.png", 6, 6, 160, 157)]
    idle = load_frames(PARALLAX / "bo-idle.png", 12, 1, 207, 230)
    stand = load_frames(PARALLAX / "bo-stand.png", 12, 1, 207, 230)

    front = pixelize(stand[0])
    east = pixelize(walk_e[narrowest_stance(walk_e, range(36))])
    west = pixelize(walk_w[narrowest_stance(walk_w, range(36))])
    north = derive_north(front)

    sections = [
        (
            "TURNAROUND",
            "stand, four facings - the bindle arm is anatomical: E and W are drawn, never mirrored",
            [("N*", north), ("E", east), ("S", front), ("W", west)],
        ),
        (
            "POSES",
            "one free arm only: the bindle arm holds the pole in every cell",
            [
                ("sit", pose_sit(front)),
                ("crouch", pose_crouch(stand[0])),
                ("hop", pose_hop(idle[4])),
                ("wave", pose_wave(front)),
                ("point E", pose_point_east(east)),
                ("startled", pose_startled(stand[0])),
            ],
        ),
        (
            "EXPRESSIONS",
            "no mouth, no brows - the eyes carry every reading",
            [
                ("neutral", front),
                ("look L", set_gaze(front, -2, 0)),
                ("look R", set_gaze(front, 2, 0)),
                ("look up", set_gaze(front, 0, -2)),
                ("wide", wide_eyes(front)),
                ("sleepy", pose_sleepy(stand[0])),
                ("blink", pixelize(stand[11])),
            ],
        ),
    ]

    sections = [
        (title, note, [(label, add_rim(px)) for label, px in cells])
        for title, note, cells in sections
    ]

    write_native_sheet(sections)
    write_presentation_sheet(sections, sections[0][2][2][1])  # rimmed S stand


CELL = 56  # native cell for the 1x sprite sheet


def write_native_sheet(sections) -> None:
    cols = max(len(cells) for _, _, cells in sections)
    sheet = np.zeros((len(sections) * CELL, cols * CELL, 4), np.uint8)
    for r, (_, _, cells) in enumerate(sections):
        for c, (_, px) in enumerate(cells):
            h, w = px.shape[:2]
            y = r * CELL + (CELL - 4 - baseline(px) - 1)  # common baseline 4px up
            x = c * CELL + (CELL - w) // 2
            region = sheet[y : y + h, x : x + w]
            region[px[:, :, 3] > 0] = px[px[:, :, 3] > 0]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(sheet).save(OUT_DIR / "bo-pixel-sprites.png")
    print("wrote", OUT_DIR / "bo-pixel-sprites.png", sheet.shape[1], "x", sheet.shape[0])


def write_presentation_sheet(sections, scale_sprite: np.ndarray) -> None:
    h1 = ImageFont.truetype(str(FONT_PATH), 48)
    h2 = ImageFont.truetype(str(FONT_PATH), 28)
    small = ImageFont.truetype(str(FONT_PATH), 22)

    cell = CELL * SCALE
    pad = 24
    label_h = 30
    section_head = 46
    cols = max(len(cells) for _, _, cells in sections)
    width = pad * 2 + cols * (cell + 8) - 8

    scale_row_h = (TARGET_H + 2) * 4 + 70
    height = (
        pad
        + 78  # header
        + sum(section_head + cell + label_h + 14 for _ in sections)
        + section_head
        + scale_row_h
        + 56  # footer
    )

    img = Image.new("RGB", (width, height), PAPER)
    draw = ImageDraw.Draw(img)

    draw.text((pad, pad - 6), "BO - PIXEL REFERENCE", font=h1, fill=OUTLINE)
    draw.text(
        (pad, pad + 44),
        f"{TARGET_H}px grid + 1px rim - flat black + white on transparency - "
        "bodies from site/public/parallax, poses by pixel surgery (identity: HoBo Rubberhose lock)",
        font=small,
        fill=MUTE,
    )
    y = pad + 78

    def blit_sprite(px: np.ndarray, x0: int, y0: int, scale: int) -> None:
        im = Image.fromarray(px).resize(
            (px.shape[1] * scale, px.shape[0] * scale), Image.NEAREST
        )
        img.paste(im, (x0, y0), im)

    for title, note, cells in sections:
        draw.text((pad, y), title, font=h2, fill=OUTLINE)
        tw = draw.textlength(title, font=h2)
        draw.text((pad + tw + 16, y + 7), note, font=small, fill=MUTE)
        y += section_head
        for c, (label, px) in enumerate(cells):
            x = pad + c * (cell + 8)
            draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=CELL_BG, outline=OUTLINE, width=2)
            w, h = px.shape[1] * SCALE, px.shape[0] * SCALE
            bx = x + (cell - w) // 2
            by = y + cell - 4 * SCALE - (baseline(px) + 1) * SCALE
            blit_sprite(px, bx, by, SCALE)
            lw = draw.textlength(label, font=small)
            draw.text((x + (cell - lw) // 2, y + cell + 4), label, font=small, fill=OUTLINE)
        y += cell + label_h + 14

    draw.text((pad, y), "SCALE + GROUNDS", font=h2, fill=OUTLINE)
    draw.text(
        (pad + draw.textlength("SCALE + GROUNDS", font=h2) + 16, y + 7),
        "integer scaling only, nearest-neighbour - the 1px rim keeps him readable on any ground",
        font=small,
        fill=MUTE,
    )
    y += section_head
    x = pad
    base_y = y + (TARGET_H + 2) * 4  # shared baseline for the ramp (rim included)
    for s in (1, 2, 3, 4):
        w, h = scale_sprite.shape[1] * s, scale_sprite.shape[0] * s
        blit_sprite(scale_sprite, x, base_y - h, s)
        draw.text((x + (w - draw.textlength(f"{s}x", font=small)) // 2, base_y + 6), f"{s}x", font=small, fill=OUTLINE)
        x += w + 28
    # ground swatches: the same 2x sprite on paper, slate and night
    for name, col in (("paper", (255, 255, 255)), ("slate", CELL_BG), ("night", (26, 20, 32))):
        w, h = scale_sprite.shape[1] * 2, scale_sprite.shape[0] * 2
        bw = w + 24
        draw.rectangle([x, base_y - h - 24, x + bw, base_y], fill=col, outline=OUTLINE, width=2)
        blit_sprite(scale_sprite, x + 12, base_y - h - 6, 2)
        draw.text((x + (bw - draw.textlength(name, font=small)) // 2, base_y + 6), name, font=small, fill=OUTLINE)
        x += bw + 20

    draw.text(
        (pad, height - 44),
        "N* is derived: front stand mirrored, enclosed whites inked out - "
        "never mirror EAST<->WEST, the bindle would swap arms.",
        font=small,
        fill=MUTE,
    )

    out = OUT_DIR / "bo-pixel-reference.png"
    img.save(out)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
