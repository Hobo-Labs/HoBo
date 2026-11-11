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
      Stood on the trail by site/src/lib/trail-props.ts.

  site/public/cast/<name>.png
      One sheet per hobit, cut from that character's reviewed pose board and
      packed to the contract in site/public/cast/cast.json: a 6x2 grid of
      256px cells, the same pose in the same cell on every sheet, feet on one
      baseline and the body on one centre column.

Generation is a separate, earlier step — the Higgsfield CLI
(`higgsfield generate create <model> ... --wait`), from the briefs in
`media/scripts/jobs/`, into the gitignored `media/runs/` — and promotion from
a run to the Reference tier is a person looking at it. See AGENTS.md,
"Generated-art rules".

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

# Stored height of the tallest landmark: about twice the ~300px the desktop
# band draws a tall prop at, which keeps the linework crisp on a 2x display
# without shipping more than that.
LANDMARK_H = 640

# Cut, so the approved set keeps one shared scale, but not shipped: no card on
# the landing page stands for them (site/src/lib/trail-props.ts).
UNPLACED = {"arch", "blimp", "lighthouse", "steamboat", "water-tower"}

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

CELL = 256
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


def _two_ink(grey: np.ndarray, solid: np.ndarray) -> np.ndarray:
	"""Reduce a keyed board to exactly what the style is: black, white, nothing.

	A model asked for flat ink still leaves soft shading, grey smudges and
	stray specks, and every one of them survives as a visible stain once the
	sprite stands on a page. At source resolution each pixel is therefore
	snapped to black ink, white paint or clear — and the antialiasing the
	shipped art needs comes from the downscale that follows, which is why
	boards are generated several times larger than they ship.
	"""
	total = solid.size
	# Dust: tiny islands of ink in the ground, and pinholes of ground in ink.
	lab, n = ndimage.label(solid, structure=np.ones((3, 3)))
	if n:
		sizes = ndimage.sum(solid, lab, index=np.arange(1, n + 1))
		solid = solid & ~np.isin(lab, np.flatnonzero(sizes < total * 0.00002) + 1)
	holes, n = ndimage.label(~solid)
	if n:
		sizes = ndimage.sum(~solid, holes, index=np.arange(1, n + 1))
		solid = solid | np.isin(holes, np.flatnonzero(sizes < total * 0.000004) + 1)

	white = solid & (grey >= 128)
	# The same for the two inks: a fleck of white in the black, or of black in
	# the white, that is too small to be a drawn mark is noise from the model.
	for ink in (white, solid & ~white):
		lab, n = ndimage.label(ink)
		if n:
			sizes = ndimage.sum(ink, lab, index=np.arange(1, n + 1))
			flip = np.isin(lab, np.flatnonzero(sizes < total * 0.000003) + 1)
			white = white ^ flip
	white &= solid
	return np.dstack([np.where(white, 255, 0), np.where(solid, 255, 0)]).astype(np.uint8)


def cut_chroma(path: Path) -> np.ndarray:
	"""Key a board drawn on a flat colour. Returns an uncropped grey+alpha array.

	Generated boards are drawn on a chroma ground rather than on white,
	because enclosure cannot tell paper from paint: an arm resting on a hip
	closes a loop of paper that flood-fill can never reach, and it ships as a
	white blob the first time the sprite stands on a dark page. On a coloured
	ground the question does not arise — neutral is ink, colour is ground.

	"Flat" is the model's word, not a fact: the ground arrives as a patchwork
	of visibly different greens. So the key does not measure how far a pixel
	is from *the* ground colour — that reads every darker patch as a film of
	ink and leaves grey ghosts of the patchwork behind. It asks only whether
	a pixel is coloured at all, and black-and-white ink never is.
	"""
	rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
	edge = np.concatenate([rgb[:10].reshape(-1, 3), rgb[-10:].reshape(-1, 3), rgb[:, :10].reshape(-1, 3), rgb[:, -10:].reshape(-1, 3)])
	ground = np.median(edge, axis=0)
	lead = int(np.argmax(ground))
	rest = [c for c in range(3) if c != lead]
	strength = float(ground[lead] - ground[rest].mean())
	if strength < 60:
		raise SystemExit(f"{path.name}: the ground is not a colour; use cut_out for art on paper")

	# How coloured each pixel is, in the ground's own direction.
	colour = rgb[..., lead] - rgb[..., rest].mean(axis=2)
	solid = colour < strength * 0.3
	# Ink is read from the channels the ground is *not* in, so spill from the
	# ground onto an edge cannot tint it.
	grey = rgb[..., rest].mean(axis=2)
	return _two_ink(grey, solid)


def cut_alpha(path: Path) -> np.ndarray:
	"""A board that arrived with a real transparent background.

	The model's own alpha says where the drawing is; the same two-ink
	reduction as a keyed board makes it the same kind of artwork.
	"""
	rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)
	grey = rgba[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
	return _two_ink(grey, rgba[..., 3] > 128)


def read_board(path: Path) -> np.ndarray:
	"""Transparent boards are used as given, chroma ones keyed, paper ones cut by enclosure."""
	source = Image.open(path)
	# A promoted board is a three-value palette PNG; its transparency lives in
	# the palette, not in a channel, until it is expanded.
	if source.mode == "P" or "transparency" in source.info:
		source = source.convert("RGBA")
	if source.mode in ("RGBA", "LA") and np.asarray(source.convert("RGBA"))[..., 3].min() < 16:
		return cut_alpha(path)
	rgb = np.asarray(source.convert("RGB"), dtype=np.float32)
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
	raised arm or a puff of smoke stays inside its cell. So the cells are never
	used as crop boxes. Every connected piece of ink is recovered whole and
	then joins the drawing whose cell its centre falls in — which keeps a
	chimney's smoke, a campfire beside its tent or a hat in mid-air with the
	thing it belongs to, and never slices a drawing along a grid line.
	"""
	solid = la[..., 1] > 24
	lab, n = ndimage.label(solid, structure=np.ones((3, 3)))
	if n == 0:
		raise SystemExit("the board is empty")
	ys, xs = np.where(solid)
	x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
	centres = ndimage.center_of_mass(solid, lab, index=np.arange(1, n + 1))
	areas = ndimage.sum(solid, lab, index=np.arange(1, n + 1))

	cell_of = np.zeros(n + 1, dtype=np.int32) - 1
	for i, (cy, cx) in enumerate(centres, start=1):
		col = min(cols - 1, max(0, int((cx - x0) / (x1 - x0) * cols)))
		row = min(rows - 1, max(0, int((cy - y0) / (y1 - y0) * rows)))
		cell_of[i] = row * cols + col

	out = []
	for cell in range(cols * rows):
		members = np.flatnonzero(cell_of == cell)
		if members.size == 0 or areas[members - 1].sum() < solid.sum() / (cols * rows) * 0.12:
			raise SystemExit(f"cell {cell} of the {cols}x{rows} board holds no drawing")
		piece = la.copy()
		piece[~np.isin(lab, members)] = 0
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
		if name in UNPLACED:
			(LANDMARKS_OUT / f"{name}.png").unlink(missing_ok=True)
			continue
		Image.fromarray(la, "LA").save(LANDMARKS_OUT / f"{name}.png", optimize=True)
		print(f"landmarks/{name}.png  {la.shape[1]}x{la.shape[0]}")


# ---------------------------------------------------------------- the cast


def _eyes(grey: np.ndarray, alpha: np.ndarray) -> list[np.ndarray]:
	"""The eye whites, each as a filled mask (white plus the pupil inside it).

	An eye is a roundish white shape that encloses a solid dark pupil. A hat
	with a stitched patch is white and encloses something too, but what it
	encloses is mostly more white; a glove encloses only hairlines. Eyes also
	come as a matched pair, so of everything that qualifies the two most alike
	in size and height are the ones — or the one, where a character's eyes
	touch and share a single white.
	"""
	white = (grey > 128) & (alpha > 128)
	dark = (grey <= 128) & (alpha > 128)
	lab, n = ndimage.label(white)
	h = grey.shape[0]
	found = []
	for i in range(1, n + 1):
		region = lab == i
		ys, xs = np.where(region)
		eh, ew = np.ptp(ys) + 1, np.ptp(xs) + 1
		if not (0.06 * h <= eh <= 0.45 * h and 0.45 < ew / eh < 2.4):
			continue
		filled = ndimage.binary_fill_holes(region)
		inside = filled & ~region
		if inside.sum() < 0.06 * filled.sum() or (inside & dark).sum() < 0.85 * inside.sum():
			continue
		if filled.sum() < 0.6 * eh * ew:
			continue
		found.append((int(filled.sum()), float(ys.mean()), filled))
	if not found:
		raise SystemExit("found no eyes on the standing pose")
	if len(found) == 1:
		return [found[0][2]]
	best = min(
		((a, b) for k, a in enumerate(found) for b in found[k + 1 :]),
		key=lambda p: abs(p[0][0] - p[1][0]) / max(p[0][0], p[1][0]) + abs(p[0][1] - p[1][1]) / h,
	)
	return [best[0][2], best[1][2]]


def _look(grey: np.ndarray, eyes: list[np.ndarray], direction: int) -> np.ndarray:
	"""Pupils slid sideways inside their own whites. Colour only."""
	out = grey.copy()
	for eye in eyes:
		width = np.ptp(np.where(eye)[1]) + 1
		dx = direction * max(2, round(width * 0.16))
		# The pupil is the dark the eye encloses, highlight and all.
		pupil = ndimage.binary_fill_holes(eye & (grey <= 128)) & eye
		cleared = np.where(pupil, 255, grey)
		moved = np.roll(np.where(pupil, grey, 255), dx, axis=1)
		if dx > 0:
			moved[:, :dx] = 255
		else:
			moved[:, dx:] = 255
		# Keep a rim of white between the pupil and the edge it slid toward.
		inner = ndimage.binary_erosion(eye, iterations=max(1, round(width * 0.05)))
		out = np.where(eye, np.where(inner, np.minimum(cleared, moved), cleared), out)
	return out.astype(np.uint8)


def _blink(grey: np.ndarray, eyes: list[np.ndarray]) -> np.ndarray:
	"""Eyes shut: each white closes down to the lower lid it already has."""
	out = grey.copy()
	rows = np.arange(grey.shape[0])[:, None]
	for eye in eyes:
		ys = np.where(eye)[0]
		lid = max(2, round((np.ptp(ys) + 1) * 0.09))
		# The lid is what is left of the eye when the shape is lifted by a
		# lid's thickness — its own bottom edge, so the curve is the drawing's.
		raised = np.roll(eye, -lid, axis=0)
		raised[-lid:] = False
		crescent = eye & ~raised & (rows > (ys.min() + ys.max()) / 2)
		out = np.where(eye, 0, out)
		out = np.where(crescent, 255, out)
	return out.astype(np.uint8)


def _ink_centre(la: np.ndarray) -> float:
	"""Column the body sits on: the centre of the dark, opaque mass."""
	dark = (la[..., 0] < 70) & (la[..., 1] > 200)
	xs = np.where(dark)[1]
	return float(xs.mean()) if xs.size else la.shape[1] / 2


def _place(pose: np.ndarray, centre: float) -> np.ndarray:
	"""One pose into one cell: feet on the baseline, `centre` on the centre column."""
	cell = np.zeros((CELL, CELL, 2), dtype=np.uint8)
	h, w = pose.shape[:2]
	left = round(CELL / 2 - centre)
	top = round(CELL * FEET) - h
	if left < 0 or top < 0 or left + w > CELL or top + h > CELL:
		raise SystemExit("a pose does not fit its cell; the fit step should have prevented this")
	cell[top : top + h, left : left + w] = pose
	return cell


def build_cast() -> None:
	manifest = CAST_BOARDS / "cast.json"
	if not manifest.exists():
		print("cast: no reviewed boards yet (media/public/reference/cast/cast.json)")
		return
	CAST_OUT.mkdir(parents=True, exist_ok=True)
	meta = {}
	for member in json.loads(manifest.read_text())["cast"]:
		name = member["name"]
		pieces = split_board(read_board(CAST_BOARDS / member["board"]), member["cols"], member["rows"])
		drawn = {key: piece for key, piece in zip(member["poses"], pieces, strict=True) if key}
		if "stand" not in drawn:
			raise SystemExit(f"{name}: the board has no standing pose to scale from")

		# The three eye states are made at full size, from the standing pose,
		# by moving colour only — so they share its silhouette exactly and a
		# peek can look around without its outline boiling.
		stand = drawn["stand"]
		grey, alpha = stand[..., 0], stand[..., 1]
		eyes = _eyes(grey, alpha)
		drawn["lookLeft"] = np.dstack([_look(grey, eyes, -1), alpha])
		drawn["lookRight"] = np.dstack([_look(grey, eyes, 1), alpha])
		drawn["blink"] = np.dstack([_blink(grey, eyes), alpha])
		# A character drawn with one run pose repeats it rather than shipping
		# an empty cell; the troupe gives a run its second beat by motion.
		if "run" in drawn:
			drawn.setdefault("runB", drawn["run"])

		# One scale for the whole character, so he is the same size in every
		# cell — set by the standing pose, then eased down until the widest
		# and tallest poses fit too. Nothing is ever cropped to make it fit.
		centres = {key: _ink_centre(piece) for key, piece in drawn.items()}
		for key in DERIVED:
			centres[key] = centres["stand"]
		scale = (CELL * BODY) / stand.shape[0]
		for key, piece in drawn.items():
			h, w = piece.shape[:2]
			reach = max(centres[key], w - centres[key])
			scale = min(scale, (CELL * FEET - 2) / h, (CELL / 2 - 2) / reach)

		sheet = np.zeros((ROWS * CELL, COLS * CELL, 2), dtype=np.uint8)
		cells = {}
		for i, key in enumerate(POSES):
			if key not in drawn:
				raise SystemExit(f"{name}: no '{key}' pose on the board and none derived")
			cells[key] = _place(resize_la(drawn[key], scale), centres[key] * scale)
			r, c = divmod(i, COLS)
			sheet[r * CELL : (r + 1) * CELL, c * CELL : (c + 1) * CELL] = cells[key]
		for key in DERIVED:
			# The invariant the derived cells exist for: colour moves, coverage does not.
			if not np.array_equal(cells[key][..., 1], cells["stand"][..., 1]):
				raise SystemExit(f"{name}: {key} changed the silhouette")
		Image.fromarray(sheet, "LA").save(CAST_OUT / f"{name}.png", optimize=True)

		ys = np.where(np.concatenate(eyes).reshape(len(eyes), *eyes[0].shape).any(axis=0))[0]
		stand_h = stand.shape[0] * scale
		crown = FEET - stand_h / CELL
		meta[name] = {
			# The standing figure's height, and how far down the cell a peek
			# must reveal to clear the eyes — both as fractions of the cell.
			"body": round(stand_h / CELL, 4),
			"peek": round(crown + (ys.max() + 0.06 * stand.shape[0]) * scale / CELL, 4),
		}
		print(f"cast/{name}.png  {sheet.shape[1]}x{sheet.shape[0]}  body {meta[name]['body']}  peek {meta[name]['peek']}")

	contract = {"cell": CELL, "cols": COLS, "rows": ROWS, "feet": FEET, "poses": POSES, "members": meta}
	(CAST_OUT / "cast.json").write_text(json.dumps(contract, indent="\t") + "\n")


if __name__ == "__main__":
	only = set(sys.argv[1:])
	if not only or "landmarks" in only:
		build_landmarks()
	if not only or "cast" in only:
		build_cast()
