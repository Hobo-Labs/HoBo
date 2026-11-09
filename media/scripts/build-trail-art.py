# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "numpy>=1.26", "scipy>=1.11"]
# ///
"""Build what stands on the trail — landmarks and the cast — from reviewed art.

Nothing here draws and nothing here generates. It takes art that has already
been looked at and approved (the Reference tier, `media/public/reference/`)
and normalizes it into what the site ships:

  site/public/parallax/landmarks/<name>.png
      Everything that stands beside the trail: the five approved scene props
      and the props cut from the reviewed prop boards. Paper to alpha, one
      line weight across the set, the same grayscale + alpha the plates use.
      Placed by site/src/lib/trail-landmarks.ts.

  site/public/cast/<name>.png
      One sheet per hobit, cut from that character's reviewed pose board and
      packed to the contract in site/src/lib/stage/cast.ts: a 6x2 grid of
      192px cells, the same pose in the same cell on every sheet, feet on one
      baseline and the body on one centre column.

Generation is a separate, earlier step (`higgsfield-run.py`, into the
gitignored `media/runs/`), and promotion from a run to the Reference tier is
a person looking at it. See AGENTS.md, "Generated-art rules".

Three rules this follows, learned the hard way on Bo's own sheets
(site/public/parallax/README.md):

  * Enclosure, not brightness, separates ink from paper. The paper is
    flood-filled from the border; anything the fill cannot reach is opaque
    however bright it is, so an eye, a glove or a clock face stays white
    instead of becoming a hole.
  * The grey channel is colour; alpha is coverage. An edge pixel is
    (grey 0, alpha partial), never (grey mid, alpha 255).
  * A pose's three eye states share one silhouette. Look-left, look-right and
    blink are derived from the standing pose by moving colour only, so a peek
    can look around without its outline boiling.

Run from the repo root:  uv run media/scripts/build-trail-art.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = ROOT / "media" / "public" / "reference"
PROPS = REFERENCE / "scene-props"
PROP_BOARDS = REFERENCE / "trail-props"
CAST_BOARDS = REFERENCE / "cast"
LANDMARKS_OUT = ROOT / "site" / "public" / "parallax" / "landmarks"
CAST_OUT = ROOT / "site" / "public" / "cast"

LEVELS = 8  # posterization steps for both channels, as the plates use

# Stored height of the tallest landmark. The band draws them at well under
# half this, so the surplus is what keeps the linework crisp on a 2x display.
LANDMARK_H = 420

# ----------------------------------------------------------- approved props

SINGLE_PROPS: dict[str, dict] = {
	"signpost": {"src": "signpost.webp"},
	"train": {"src": "train.webp"},
	"depot": {"src": "depot.webp"},
	"blimp": {"src": "blimp.webp"},
	# The reference carries a lettered "toot" beside the funnel. Lettering
	# baked into art cannot be themed or translated, and the catalogue already
	# records it as removed at trace — so it is removed here too.
	"steamboat": {"src": "steamboat.webp", "erase": [(470, 225, 620, 345)]},
}

# ------------------------------------------------------------- the contract

CELL = 192
COLS, ROWS = 6, 2
FEET = 0.94  # feet baseline, as a fraction of the cell height
BODY = 0.62  # the standing figure's height, as a fraction of the cell height
POSES = [
	"stand", "lookLeft", "lookRight", "blink", "wave", "startled",
	"doze", "walkA", "walkPass", "walkB", "run", "runB",
]  # fmt: skip
DERIVED = {"lookLeft", "lookRight", "blink"}


def _posterize(a: np.ndarray, levels: int = LEVELS) -> np.ndarray:
	step = 255 / (levels - 1)
	return (np.round(a / step) * step).clip(0, 255).astype(np.uint8)


def cut_out(
	path: Path,
	erase: list[tuple[int, int, int, int]] | None = None,
	crop: bool = True,
) -> np.ndarray:
	"""Paper to alpha by enclosure. Returns an (h, w, 2) grey+alpha array."""
	rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
	luma = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

	# Paper level is measured, not assumed: these arrive on anything from pure
	# white to cream stock with a darker vignette, and a fixed threshold either
	# eats light linework or keeps the paper as faint ink.
	border = np.concatenate([luma[:8].ravel(), luma[-8:].ravel(), luma[:, :8].ravel(), luma[:, -8:].ravel()])
	paper = float(np.median(border))
	# A soft local estimate handles the vignette: divide by a heavily blurred
	# copy of the bright pixels so the corners level out with the middle.
	filled = np.where(luma > paper * 0.72, luma, paper)
	local = ndimage.gaussian_filter(filled, sigma=60)
	norm = (luma / np.maximum(local, 1) * 255).clip(0, 255)

	for x0, y0, x1, y1 in erase or []:
		norm[y0:y1, x0:x1] = 255

	ink = norm < 150
	# Specks: components under ~0.004% of the frame are dust, and one of them
	# is enough to throw a crop box out by a margin's width.
	lab, n = ndimage.label(ink, structure=np.ones((3, 3)))
	if n:
		sizes = ndimage.sum(ink, lab, index=np.arange(1, n + 1))
		small = np.isin(lab, np.flatnonzero(sizes < ink.size * 0.00004) + 1)
		norm[small] = 255
		ink &= ~small

	# The paper is everything not-ink that touches the border.
	free, _ = ndimage.label(~ink)
	edge = np.unique(np.concatenate([free[0], free[-1], free[:, 0], free[:, -1]]))
	outside = np.isin(free, edge[edge != 0])

	alpha = np.where(outside, 0.0, 255.0)
	grey = np.where(outside, 0.0, norm)
	# Antialiasing lives in alpha. Paper within a pixel of ink takes the ink's
	# coverage; ink within two pixels of paper goes to pure black, so a thin
	# stroke is (0, partial) and not a soft grey stick.
	near_ink = ndimage.binary_dilation(~outside, iterations=1) & outside
	alpha = np.where(near_ink, 255.0 - norm, alpha)
	near_paper = ndimage.binary_dilation(outside, iterations=2) & ~outside
	grey = np.where(near_paper & (norm < 200), 0.0, grey)
	grey = np.where(near_ink, 0.0, grey)

	la = np.dstack([grey, alpha]).astype(np.uint8)
	return _tight(la) if crop else la


def cut_chroma(path: Path) -> np.ndarray:
	"""Key a board drawn on a flat colour. Returns an uncropped grey+alpha array.

	Generated boards are drawn on a flat chroma ground rather than on white,
	because enclosure cannot tell paper from paint: an arm resting on a hip
	closes a loop of paper that flood-fill can never reach, and it ships as a
	white blob the first time the sprite stands on a dark page. On a coloured
	ground the question does not arise — white is paint, colour is ground.

	Black-and-white ink over one flat colour is exactly solvable. Every pixel
	is `a * ink + (1 - a) * ground` with a neutral ink, so its distance from
	the grey axis is the ground's, scaled by how much ground shows through.
	That gives coverage directly, and the ink's own grey falls out of it —
	no threshold, and no colour fringe left on an antialiased edge.
	"""
	rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
	edge = np.concatenate([rgb[:10].reshape(-1, 3), rgb[-10:].reshape(-1, 3), rgb[:, :10].reshape(-1, 3), rgb[:, -10:].reshape(-1, 3)])
	ground = np.median(edge, axis=0)
	chroma = ground - ground.mean()
	if float(chroma @ chroma) < 40**2:
		raise SystemExit(f"{path.name}: the ground is not a colour; use cut_out for art on paper")

	mean = rgb.mean(axis=2)
	off_axis = rgb - mean[..., None]
	# A generated "flat" ground wanders a few levels; a soft local estimate of
	# how saturated it is keeps that drift from reading as faint ink.
	raw = (off_axis @ chroma) / float(chroma @ chroma)
	is_ground = raw > 0.82
	level = ndimage.gaussian_filter(np.where(is_ground, raw, 0.0), 40) / np.maximum(
		ndimage.gaussian_filter(is_ground.astype(np.float32), 40), 1e-3
	)
	through = (raw / np.maximum(level, 0.5)).clip(0, 1)
	cover = 1 - through
	cover = np.where(cover < 0.1, 0.0, np.where(cover > 0.93, 1.0, cover))

	grey = ((mean - through * ground.mean()) / np.maximum(cover, 1e-3)).clip(0, 255)
	grey = np.where(cover > 0, grey, 0)
	# Partial coverage is an edge, and an edge is ink: (0, partial).
	grey = np.where(cover < 1, np.where(grey < 150, 0.0, 255.0), grey)

	solid = cover > 0
	lab, n = ndimage.label(solid, structure=np.ones((3, 3)))
	if n:
		sizes = ndimage.sum(solid, lab, index=np.arange(1, n + 1))
		specks = np.isin(lab, np.flatnonzero(sizes < solid.size * 0.00003) + 1)
		cover = np.where(specks, 0.0, cover)
	return np.dstack([grey, cover * 255]).astype(np.uint8)


def read_board(path: Path) -> np.ndarray:
	"""A board on a chroma ground is keyed; one on paper is cut by enclosure."""
	rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
	corner = np.median(np.concatenate([rgb[:10].reshape(-1, 3), rgb[-10:].reshape(-1, 3)]), axis=0)
	chroma = corner - corner.mean()
	return cut_chroma(path) if float(chroma @ chroma) >= 40**2 else cut_out(path, crop=False)


def _tight(la: np.ndarray, pad: int = 4) -> np.ndarray:
	ys, xs = np.where(la[..., 1] > 24)
	y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, la.shape[0])
	x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad + 1, la.shape[1])
	return la[y0:y1, x0:x1]


def resize_la(la: np.ndarray, scale: float) -> np.ndarray:
	"""Premultiplied resize, so a black edge does not pick up a white fringe."""
	a = la.astype(np.float32)
	grey, alpha = a[..., 0], a[..., 1] / 255
	h, w = la.shape[:2]
	size = (max(1, round(w * scale)), max(1, round(h * scale)))
	pm = Image.fromarray(grey * alpha, "F").resize(size, Image.LANCZOS)
	al = Image.fromarray(alpha, "F").resize(size, Image.LANCZOS)
	pm_a, al_a = np.asarray(pm), np.asarray(al).clip(0, 1)
	out_grey = np.where(al_a > 1e-3, pm_a / np.maximum(al_a, 1e-3), 0).clip(0, 255)
	return np.dstack([_posterize(out_grey), _posterize(al_a * 255)])


def split_board(la: np.ndarray, cols: int, rows: int) -> list[np.ndarray]:
	"""Cut a board into its drawings, in reading order.

	A grid is only where the drawings were *asked* to go; nothing guarantees a
	raised arm or a popped hat stays inside its cell. So the cells are never
	trusted as crop boxes. Each drawing is recovered as connected ink — the
	large components are the drawings, and every loose piece (a hat in mid-air,
	a puff of smoke) joins the drawing it is nearest to.
	"""
	solid = la[..., 1] > 24
	# Bridge hairline gaps inside one drawing without merging two drawings.
	lab, n = ndimage.label(ndimage.binary_dilation(solid, iterations=3))
	lab = np.where(solid, lab, 0)
	areas = ndimage.sum(solid, lab, index=np.arange(1, n + 1))
	order = np.argsort(areas)[::-1]
	want = cols * rows
	if n < want:
		raise SystemExit(f"board has {n} drawings, expected {want}")
	cores = [int(i) + 1 for i in order[:want]]
	boxes = ndimage.find_objects(lab)
	centre = lambda i: ((boxes[i - 1][1].start + boxes[i - 1][1].stop) / 2, (boxes[i - 1][0].start + boxes[i - 1][0].stop) / 2)  # noqa: E731

	owner = {c: c for c in cores}
	for i in order[want:]:
		piece = int(i) + 1
		if areas[i] < 12:
			continue
		px, py = centre(piece)
		owner[piece] = min(cores, key=lambda c: (centre(c)[0] - px) ** 2 + (centre(c)[1] - py) ** 2)

	# Reading order: rows by height on the page, then left to right.
	by_y = sorted(cores, key=lambda c: centre(c)[1])
	grid = [sorted(by_y[r * cols : (r + 1) * cols], key=lambda c: centre(c)[0]) for r in range(rows)]

	out = []
	for core in (c for row in grid for c in row):
		mine = np.isin(lab, [p for p, c in owner.items() if c == core])
		# Everything opaque that belongs to this drawing, antialiased rim included.
		keep = ndimage.binary_dilation(mine, iterations=2) & (la[..., 1] > 0)
		piece = la.copy()
		piece[~keep] = 0
		out.append(_tight(piece, pad=2))
	return out


# ------------------------------------------------------------- landmarks


def build_landmarks() -> None:
	LANDMARKS_OUT.mkdir(parents=True, exist_ok=True)
	cuts: dict[str, np.ndarray] = {
		name: cut_out(PROPS / spec["src"], spec.get("erase")) for name, spec in SINGLE_PROPS.items()
	}
	# One scale for the approved five, so their line weights agree with each
	# other the way they do in the reference set.
	tallest = max(c.shape[0] for c in cuts.values())
	sized = {name: resize_la(cut, LANDMARK_H / tallest) for name, cut in cuts.items()}

	manifest = PROP_BOARDS / "boards.json"
	if manifest.exists():
		for board in json.loads(manifest.read_text())["boards"]:
			la = read_board(PROP_BOARDS / board["file"])
			pieces = split_board(la, board["cols"], board["rows"])
			# Board props are drawn smaller than the full-frame five, so each
			# board declares how tall its tallest prop should stand next to them.
			top = max(p.shape[0] for p in pieces)
			for name, piece in zip(board["names"], pieces, strict=True):
				if name:
					sized[name] = resize_la(piece, board.get("height", LANDMARK_H) / top)

	for name, la in sized.items():
		Image.fromarray(la, "LA").save(LANDMARKS_OUT / f"{name}.png", optimize=True)
		print(f"landmarks/{name}.png  {la.shape[1]}x{la.shape[0]}")


# ---------------------------------------------------------------- the cast


def _eyes(grey: np.ndarray, alpha: np.ndarray) -> list[np.ndarray]:
	"""The eye whites, each as a filled mask (white plus the pupil inside it).

	Usually two. A character whose eyes touch has one region holding both
	pupils, and that is fine: everything downstream moves pupils *within* a
	mask and never needs to know how many it holds.
	"""
	white = (grey > 200) & (alpha == 255)
	lab, n = ndimage.label(white)
	h = grey.shape[0]
	found = []
	for i in range(1, n + 1):
		region = lab == i
		ys, xs = np.where(region)
		eh, ew = np.ptp(ys) + 1, np.ptp(xs) + 1
		filled = ndimage.binary_fill_holes(region)
		# An eye is a white shape that encloses a dark pupil. A glove or a hat
		# is white too, but encloses nothing dark worth the name.
		pupil = (filled & ~region).sum()
		if 0.07 * h <= eh <= 0.4 * h and 0.5 < ew / eh < 2.6 and pupil > 0.05 * filled.sum():
			found.append((filled.sum(), filled))
	found.sort(key=lambda f: -f[0])
	if not found:
		raise SystemExit("found no eyes on the standing pose")
	return [f[1] for f in found[:2]]


def _look(grey: np.ndarray, eyes: list[np.ndarray], direction: int) -> np.ndarray:
	out = grey.astype(np.float32).copy()
	for eye in eyes:
		width = np.ptp(np.where(eye)[1]) + 1
		dx = direction * max(2, round(width * 0.14))
		src = grey.astype(np.float32)
		core = eye & (src < 128)
		# The pupil, with the antialiased pixel around it and the highlight in it.
		pupil = ndimage.binary_fill_holes(ndimage.binary_dilation(core, iterations=1)) & eye
		cleared = np.where(pupil, 255.0, src)
		moved = np.roll(np.where(pupil, src, 255.0), dx, axis=1)
		if dx > 0:
			moved[:, :dx] = 255.0
		else:
			moved[:, dx:] = 255.0
		# Keep one white pixel between the pupil and the rim it slid toward.
		inner = ndimage.binary_erosion(eye, iterations=1)
		out = np.where(eye, np.where(inner, np.minimum(cleared, moved), cleared), out)
	return out.astype(np.uint8)


def _blink(grey: np.ndarray, eyes: list[np.ndarray]) -> np.ndarray:
	"""Eyes shut: each white closes down to the lower lid it already has."""
	out = grey.copy()
	for eye in eyes:
		height = np.ptp(np.where(eye)[0]) + 1
		lid = max(2, round(height * 0.1))
		# The lid is the part of the eye that is no longer eye when the shape
		# is shifted up — its own bottom edge, so the curve is the drawing's.
		raised = np.roll(eye, -lid, axis=0)
		raised[-lid:] = False
		crescent = eye & ~raised
		# Only the lower half: the same shift also leaves nothing at the top.
		ys = np.where(eye)[0]
		crescent &= np.arange(grey.shape[0])[:, None] > (ys.min() + ys.max()) / 2
		out = np.where(eye, 0, out)
		out = np.where(crescent, 255, out)
	return out.astype(np.uint8)


def _ink_centre(la: np.ndarray) -> float:
	"""Column the body sits on: the centre of the dark, opaque mass."""
	dark = (la[..., 0] < 70) & (la[..., 1] > 200)
	xs = np.where(dark)[1]
	return float(xs.mean()) if xs.size else la.shape[1] / 2


def _place(pose: np.ndarray) -> np.ndarray:
	"""One pose into one cell: feet on the baseline, body on the centre column."""
	cell = np.zeros((CELL, CELL, 2), dtype=np.uint8)
	h, w = pose.shape[:2]
	left = round(CELL / 2 - _ink_centre(pose))
	top = round(CELL * FEET) - h
	# A flung-out limb may leave the cell; the body may not.
	x0, y0 = max(left, 0), max(top, 0)
	x1, y1 = min(left + w, CELL), min(top + h, CELL)
	if x1 <= x0 or y1 <= y0:
		raise SystemExit("a pose landed entirely outside its cell")
	cell[y0:y1, x0:x1] = pose[y0 - top : y1 - top, x0 - left : x1 - left]
	return cell


def build_cast() -> None:
	manifest = CAST_BOARDS / "cast.json"
	if not manifest.exists():
		print("cast: no reviewed boards yet (media/public/reference/cast/cast.json)")
		return
	CAST_OUT.mkdir(parents=True, exist_ok=True)
	for member in json.loads(manifest.read_text())["cast"]:
		name = member["name"]
		la = read_board(CAST_BOARDS / member["board"])
		pieces = split_board(la, member["cols"], member["rows"])
		drawn = dict(zip(member["poses"], pieces, strict=True))
		if "stand" not in drawn:
			raise SystemExit(f"{name}: the board has no standing pose to scale from")

		# One scale for the whole character, set by the standing pose, so he is
		# the same size in every cell rather than each pose being fitted to it.
		scale = (CELL * BODY) / drawn["stand"].shape[0]
		poses = {key: resize_la(piece, scale) for key, piece in drawn.items() if key}

		stand = _place(poses["stand"])
		grey, alpha = stand[..., 0], stand[..., 1]
		eyes = _eyes(grey, alpha)
		cells = {key: _place(pose) for key, pose in poses.items()}
		cells["lookLeft"] = np.dstack([_look(grey, eyes, -1), alpha])
		cells["lookRight"] = np.dstack([_look(grey, eyes, 1), alpha])
		cells["blink"] = np.dstack([_blink(grey, eyes), alpha])
		for key in DERIVED:
			# The invariant the derived frames exist for: colour moves, coverage does not.
			if not np.array_equal(cells[key][..., 1], alpha):
				raise SystemExit(f"{name}: {key} changed the silhouette")
		# A character drawn with one run pose alternates it with the high walk
		# pose rather than shipping an empty cell.
		cells.setdefault("runB", cells.get("run", stand))

		sheet = np.zeros((ROWS * CELL, COLS * CELL, 2), dtype=np.uint8)
		for i, key in enumerate(POSES):
			if key not in cells:
				raise SystemExit(f"{name}: no '{key}' pose on the board and none derived")
			r, c = divmod(i, COLS)
			sheet[r * CELL : (r + 1) * CELL, c * CELL : (c + 1) * CELL] = cells[key]
		Image.fromarray(sheet, "LA").save(CAST_OUT / f"{name}.png", optimize=True)
		print(f"cast/{name}.png  {sheet.shape[1]}x{sheet.shape[0]}  ({len(POSES)} poses)")


if __name__ == "__main__":
	only = set(sys.argv[1:])
	if not only or "landmarks" in only:
		build_landmarks()
	if not only or "cast" in only:
		build_cast()
