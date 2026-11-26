import sharp from "sharp";
import { Potrace } from "potrace";
import { writeFileSync } from "node:fs";

// Signpost layer trace: base (post+grass) + one layer per arrow board, each
// board rigged to wobble around its nail on the post. Same enclosure test as
// the mascot trace: paper is white reachable from the border; everything else
// is the prop, including the white board interiors.

function tracePath(buf, opts = {}) {
	return new Promise((res, rej) => {
		const p = new Potrace({ threshold: 128, turdSize: 8, optCurve: true, alphaMax: 1, ...opts });
		p.loadImage(buf, (err) => {
			if (err) return rej(err);
			const d = [...p.getSVG().matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(" ");
			res(d);
		});
	});
}

const SRC = "prop-signpost.png";
const SIZE = 1024;
const { data, info } = await sharp(SRC).resize(SIZE, SIZE, { fit: "contain", background: "#fff" })
	.flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
const ch = info.channels, w = info.width, h = info.height;

// ink = not reachable from border through bright paper
const outside = new Uint8Array(w * h);
{
	const st = [];
	const push = (i) => { if (!outside[i] && data[i * ch] > 200) { outside[i] = 1; st.push(i); } };
	for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
	for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
	while (st.length) {
		const i = st.pop(), x = i % w, y = (i / w) | 0;
		if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
		if (y > 0) push(i - w); if (y < h - 1) push(i + w);
	}
}
const ink = (i) => !outside[i];

// ---- post corridor -------------------------------------------------------
// Rows where the ink is narrow are post-only rows; fit a line through their
// centers to get the slanting post axis, then a corridor around it.
const rows = [];
for (let y = 0; y < h; y++) {
	let x0 = -1, x1 = -1;
	for (let x = 0; x < w; x++) if (ink(y * w + x)) { if (x0 < 0) x0 = x; x1 = x; }
	rows.push({ x0, x1, width: x0 < 0 ? 0 : x1 - x0 + 1 });
}
const postRows = [];
for (let y = 0; y < h; y++) {
	const r = rows[y];
	if (r.width > 0 && r.width < 140) postRows.push({ y, cx: (r.x0 + r.x1) / 2 });
}
// least squares cx = a*y + b
let sy = 0, sc = 0, syy = 0, syc = 0, n = postRows.length;
for (const { y, cx } of postRows) { sy += y; sc += cx; syy += y * y; syc += y * cx; }
const a = (n * syc - sy * sc) / (n * syy - sy * sy), b = (sc - a * sy) / n;
const postCx = (y) => a * y + b;
console.log(`post axis: cx = ${a.toFixed(4)}*y + ${b.toFixed(1)}  (${n} post-only rows)`);
const HALF = 62; // corridor half-width in 1024 space (post ~75px wide)

// ---- arm components ------------------------------------------------------
// components of ink outside the corridor
function components(test) {
	const seen = new Uint8Array(w * h), out = [];
	for (let s0 = 0; s0 < w * h; s0++) {
		if (seen[s0] || !test(s0)) continue;
		const stack = [s0]; seen[s0] = 1;
		let x0 = w, x1 = -1, y0 = h, y1 = -1, cnt = 0; const px = [];
		while (stack.length) {
			const i = stack.pop(); cnt++; px.push(i);
			const x = i % w, y = (i / w) | 0;
			if (x < x0) x0 = x; if (x > x1) x1 = x;
			if (y < y0) y0 = y; if (y > y1) y1 = y;
			for (const j of [i - 1, i + 1, i - w, i + w]) {
				if (j < 0 || j >= w * h || seen[j] || !test(j)) continue;
				seen[j] = 1; stack.push(j);
			}
		}
		out.push({ x0, x1, y0, y1, n: cnt, px });
	}
	return out;
}
const GRASS_Y = h * 0.72; // below this, side pieces are grass, not boards
const outsideCorridor = (i) => {
	const x = i % w, y = (i / w) | 0;
	return ink(i) && Math.abs(x - postCx(y)) > HALF;
};
const pieces = components(outsideCorridor).filter((c) => c.n > 300 && c.y0 < GRASS_Y);
pieces.sort((p, q) => p.y0 - q.y0);
console.log("board pieces:", pieces.map((p) => `[y ${p.y0}-${p.y1}, x ${p.x0}-${p.x1}, n=${p.n}]`).join("\n  "));

// Pair pieces across the corridor by y-overlap: each arm = the big piece plus
// any small stub on the other side whose y-range overlaps it.
const big = pieces.filter((p) => p.n > 4000);
const stubs = pieces.filter((p) => p.n <= 4000);
const arms = big.map((p) => ({ pieces: [p] }));
for (const s of stubs) {
	let best = null, bestOv = 0;
	for (const arm of arms) {
		const p = arm.pieces[0];
		const ov = Math.min(p.y1, s.y1) - Math.max(p.y0, s.y0);
		if (ov > bestOv) { bestOv = ov; best = arm; }
	}
	if (best && bestOv > 10) best.pieces.push(s);
	else console.log("unpaired stub", s.y0, s.y1, s.n);
}

// Arm masks: pieces + corridor pixels in the y-band the board occupies where
// it crosses the post. Band = lerp between the piece edge y-ranges at the
// corridor boundaries.
// Arm 4 (the short broken board) passes BEHIND the post in the source art:
// the post keeps its front face on the base layer, and the arm renders as one
// CONTINUOUS board underneath it — its real ink up to the post edges plus a
// synthetic middle tucked behind the post — so z-order does the occlusion and
// a wobble moves the whole board, not two orphaned stubs.
const BEHIND = new Set([3]);
// Exact post edges: post-only rows give them directly; other rows lerp
// between the nearest post-only rows above and below.
const postEdgeAt = (() => {
	const known = postRows.map(({ y }) => ({ y, l: rows[y].x0, r: rows[y].x1 }))
		.sort((p, q) => p.y - q.y);
	return (y) => {
		let lo = null, hi = null;
		for (const k of known) { if (k.y <= y) lo = k; if (k.y >= y) { hi = k; break; } }
		if (!lo) return hi; if (!hi) return lo;
		if (hi.y === lo.y) return lo;
		const t = (y - lo.y) / (hi.y - lo.y);
		return { l: lo.l + (hi.l - lo.l) * t, r: lo.r + (hi.r - lo.r) * t };
	};
})();
const synthInt = new Uint8Array(w * h);  // synthetic board interior (always light)
const synthEdge = new Uint8Array(w * h); // synthetic board outline (always dark)
const armMasks = arms.map(() => new Uint8Array(w * h));
const occluded = new Uint8Array(h); // rows where a board crosses the corridor
arms.forEach((arm, k) => {
	const m = armMasks[k];
	for (const p of arm.pieces) for (const i of p.px) m[i] = 1;
	// find, at each corridor edge, the y-extent of arm pixels adjacent to it
	const edgeSpan = (side) => { // side -1 = left edge, +1 = right edge
		let y0 = h, y1 = -1;
		for (let y = 0; y < h; y++) {
			const cx = postCx(y);
			const x = Math.round(cx + side * (HALF + 2));
			for (let dx = 0; dx < 6; dx++) {
				const xx = x + side * dx;
				if (xx < 0 || xx >= w) continue;
				if (m[y * w + xx]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
			}
		}
		return y1 < 0 ? null : { y0, y1 };
	};
	const L = edgeSpan(-1), R = edgeSpan(1);
	if (!L && !R) return;
	// The board is a slab: lerp its top/bottom edges across the corridor from
	// the spans at each corridor boundary, so slanted boards claim only their
	// own pixels and visible post between boards stays with the base.
	const lo = L ?? R, ro = R ?? L;
	const y0 = Math.min(lo.y0, ro.y0), y1 = Math.max(lo.y1, ro.y1);
	const xl = (y) => postCx(y) - HALF - 2, xr = (y) => postCx(y) + HALF + 2;
	if (!BEHIND.has(k)) {
		for (let y = y0; y <= y1; y++) {
			let any = false;
			for (let x = Math.round(xl(y)); x <= Math.round(xr(y)); x++) {
				const t = (x - xl(y)) / (xr(y) - xl(y));
				const top = lo.y0 + (ro.y0 - lo.y0) * t - 3;
				const bot = lo.y1 + (ro.y1 - lo.y1) * t + 3;
				const i = y * w + x;
				if (y >= top && y <= bot && ink(i)) { m[i] = 1; any = true; }
			}
			if (any) occluded[y] = 1;
		}
	} else {
		// Behind the post: claim the board's real ink up to the post edges,
		// synthesize the hidden middle strictly inside them. Base keeps the
		// post front untouched; no bridge, no occluded rows.
		for (let x = Math.round(xl(0)); x <= Math.round(xr(0)) + 4; x++) {
			// slab band at this column, lerped across the corridor
			for (let y = y0 - 4; y <= y1 + 4; y++) {
				const t = Math.min(1, Math.max(0, (x - xl(y)) / (xr(y) - xl(y))));
				const top = lo.y0 + (ro.y0 - lo.y0) * t - 2;
				const bot = lo.y1 + (ro.y1 - lo.y1) * t + 2;
				if (y < top || y > bot) continue;
				const i = y * w + x;
				const pe = postEdgeAt(y);
				if (x < pe.l - 2 || x > pe.r + 2) {
					if (ink(i)) m[i] = 1; // real board ink, safely clear of the post outline
				} else {
					// Hidden middle. Its dark top/bottom edges stay deep inside
					// the post so a lerp error in the post edges can never poke
					// dark pixels out beside the post; the outline columns are
					// bridged light-only to keep the board one traced piece.
					m[i] = 1;
					if ((y - top < 6 || bot - y < 6) && x > pe.l + 8 && x < pe.r - 8) synthEdge[i] = 1;
					else synthInt[i] = 1;
				}
			}
		}
	}
	arm.behind = BEHIND.has(k);
	arm.band = { y0, y1 };
	arm.pivot = { x: Math.round(postCx((y0 + y1) / 2)), y: Math.round((y0 + y1) / 2) };
	const allX = arm.pieces.flatMap((p) => [p.x0, p.x1]);
	arm.dir = Math.min(...allX) < postCx((y0 + y1) / 2) - HALF - 40 &&
		Math.max(...allX) > postCx((y0 + y1) / 2) + HALF + 40 ? "both"
		: Math.min(...allX) < postCx((y0 + y1) / 2) ? "left" : "right";
});

// ---- base mask: everything not claimed by an arm, plus a synthetic post
// bridge through occluded bands so wobble never opens a gap.
const base = new Uint8Array(w * h);
// A pixel a behind-arm claims synthetically is post front — it stays on the
// base too; the post simply renders over the hidden board.
for (let i = 0; i < w * h; i++) {
	if (!ink(i)) continue;
	const claimed = armMasks.some((m, k) => m[i] && !(BEHIND.has(k) && (synthInt[i] || synthEdge[i])));
	if (!claimed) base[i] = 1;
}
const bridgeEdge = new Uint8Array(w * h); // synthetic dark edge pixels
{
	// post left/right edges on non-occluded rows (post exists roughly from the
	// top of the topmost band to the grass)
	const edges = Array.from({ length: h }, () => null);
	for (let y = 0; y < h; y++) {
		if (occluded[y]) continue;
		const cx = postCx(y);
		let l = -1, r = -1;
		for (let x = Math.round(cx - HALF); x <= Math.round(cx + HALF); x++) {
			if (base[y * w + x]) { if (l < 0) l = x; r = x; }
		}
		if (l >= 0 && r - l > 30) edges[y] = { l, r };
	}
	for (let y = 0; y < h; y++) {
		if (!occluded[y]) continue;
		let up = y, dn = y;
		while (up >= 0 && !edges[up]) up--;
		while (dn < h && !edges[dn]) dn++;
		if (up < 0 || dn >= h || !edges[up] || !edges[dn]) continue;
		const t = (y - up) / (dn - up);
		const l = Math.round(edges[up].l + (edges[dn].l - edges[up].l) * t);
		const r = Math.round(edges[up].r + (edges[dn].r - edges[up].r) * t);
		for (let x = l; x <= r; x++) base[y * w + x] = 1;
		for (let x = l; x < l + 7; x++) bridgeEdge[y * w + x] = 1;
		for (let x = r - 6; x <= r; x++) bridgeEdge[y * w + x] = 1;
	}
}

// ---- trace layers --------------------------------------------------------
const maskPng = (test) => {
	const buf = Buffer.alloc(w * h);
	for (let i = 0; i < w * h; i++) buf[i] = test(i) ? 0 : 255; // potrace traces black
	return sharp(buf, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
};
const bright = (i) => data[i * ch] > 170;

const layers = [];
// base: silhouette dark, interior light. Bridge interior counts as light,
// bridge edges count as dark.
layers.push({
	name: "base",
	silhouette: await tracePath(await maskPng((i) => base[i]), { turdSize: 24 }),
	light: await tracePath(await maskPng((i) => base[i] && !bridgeEdge[i] && (bright(i) || (occluded[(i / w) | 0] && !bridgeEdge[i]))), { turdSize: 12 }),
});
for (let k = 0; k < arms.length; k++) {
	const m = armMasks[k];
	layers.push({
		name: `arm${k + 1}`,
		dir: arms[k].dir,
		behind: arms[k].behind || false,
		pivot: arms[k].pivot,
		band: arms[k].band,
		silhouette: await tracePath(await maskPng((i) => m[i]), { turdSize: 24 }),
		light: await tracePath(await maskPng((i) => m[i] && (synthInt[i] || (!synthEdge[i] && bright(i)))), { turdSize: 12 }),
	});
}
for (const l of layers) console.log(l.name.padEnd(6), l.dir ?? "", l.pivot ? `pivot ${l.pivot.x},${l.pivot.y}` : "", `sil ${(l.silhouette.length / 1024).toFixed(1)}KB light ${(l.light.length / 1024).toFixed(1)}KB`);
writeFileSync("signpost-layers.json", JSON.stringify({ size: SIZE, layers }));

// ---- debug overlay -------------------------------------------------------
const colors = [[120, 120, 120], [230, 60, 60], [60, 140, 230], [50, 180, 90], [230, 160, 40], [170, 80, 200], [40, 200, 200]];
const rgb = Buffer.alloc(w * h * 3, 255);
for (let i = 0; i < w * h; i++) {
	let c = null;
	if (base[i]) c = colors[0];
	for (let k = 0; k < arms.length; k++) if (armMasks[k][i]) c = colors[k + 1];
	if (bridgeEdge[i]) c = [0, 0, 0];
	if (c) { rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
}
await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toFile("signpost-debug.png");
console.log("wrote signpost-debug.png");
