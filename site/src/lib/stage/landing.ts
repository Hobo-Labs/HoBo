import contract from "../../../public/cast/cast.json";
import { isPaused, isStill, onMotionChange, prefersStill, restoreMotion, setPaused } from "./motion";
import {
	canScroll,
	clampStop,
	hashForStop,
	inStageZone,
	type KeyPlace,
	keyDirection,
	moreSides,
	pageKeepsKey,
	readsDown,
	scrollAmount,
	startsGesture,
	stopFromHash,
	trailTakes,
	fits,
} from "./trail-logic";

type PropArt = { key: string; src: string; aspect: number; units: number; say: string };

type Item = {
	card: HTMLElement | null;
	art: PropArt | null;
	wide: boolean;
	board: HTMLElement | null;
	pnode: HTMLElement | null;
	dprop: HTMLElement | null;
	x: number;
	w: number;
	want: number;
	on: boolean;
};

type Pop = { node: HTMLElement; x: number; w: number; want: number; on: boolean };

type ExtraKind = "hint" | "tuck" | "cog";

type Sign = { node: HTMLElement; inner: HTMLElement };

type Cart = { node: HTMLElement; rider: HTMLElement; gone: boolean };

type Stop = {
	key: string;
	name: string;
	title: string;
	sign: string;
	sec: HTMLElement;
	head: HTMLElement | null;
	items: Item[];
	extra: ExtraKind | null;
	set: HTMLElement;
	signNode: HTMLElement;
	folds: number;
	parts: HTMLElement[];
	cards: HTMLElement[];
	bb: Pop | null;
	pos: number;
	anchor: number;
	gone: number;
	cue: number;
};

const POSES = contract.poses;
const HOBITS = new Map([
	["tuck", "Tuck was asleep by the road."],
	["cog", "Cog took off on the handcar."],
	["mags", "Mags peeks when you stop."],
	["pip", "Pip likes a race."],
]);

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const now = () => performance.now();

function el(tag: string, cls = "", html = ""): HTMLElement {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (html) n.innerHTML = html;
	return n;
}

function pose(n: HTMLElement, name: string): void {
	const q = Math.max(0, POSES.indexOf(name));
	n.style.backgroundPosition = `${(q % contract.cols) * 20}% ${Math.floor(q / contract.cols) * 100}%`;
}

function readProps(stage: HTMLElement): Map<string, PropArt> {
	const found = new Map<string, PropArt>();
	for (const li of stage.querySelectorAll<HTMLElement>("[data-props] li")) {
		const { key = "", src = "", aspect = "1", units = "100", say = "" } = li.dataset;
		found.set(key, { key, src, aspect: Number(aspect), units: Number(units), say });
	}
	return found;
}

function readCast(stage: HTMLElement): Map<string, string> {
	const found = new Map<string, string>();
	for (const li of stage.querySelectorAll<HTMLElement>("[data-cast] li")) found.set(li.dataset.key ?? "", li.dataset.src ?? "");
	return found;
}

function extraOf(value: string | undefined): ExtraKind | null {
	return value === "hint" || value === "tuck" || value === "cog" ? value : null;
}

function keyPlace(target: EventTarget | null): KeyPlace {
	if (!(target instanceof Element)) return "page";
	if (target.closest("input, textarea, select, [contenteditable], .palette-picker, .site-nav")) return "editable";
	if (target.closest(".table-wrap, pre")) return "sideways";
	return "page";
}

export function mountLanding(page: HTMLElement, stage: HTMLElement): void {
	restoreMotion();
	const root = document.documentElement;
	let live: (() => void) | null = null;

	const sync = () => {
		const wanted = !root.dataset.design && innerHeight >= 460;
		if (wanted && !live) live = stageOn(page, stage);
		else if (!wanted && live) {
			live();
			live = null;
		}
	};
	new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-design"] });
	addEventListener("resize", sync);
	sync();
}

type Band = {
	scene: HTMLElement;
	world: HTMLElement;
	sets: HTMLElement;
	bo: HTMLElement;
	boWalk: HTMLElement;
	boLeft: HTMLElement;
	iris: HTMLElement;
	route: HTMLElement;
	routeList: HTMLElement;
	prevBtn: HTMLButtonElement;
	nextBtn: HTMLButtonElement;
	pauseBtn: HTMLButtonElement;
	help: HTMLElement;
	said: HTMLElement;
	toast: HTMLElement;
};

function bandOf(stage: HTMLElement): Band | null {
	const get = (sel: string) => stage.querySelector<HTMLElement>(sel);
	const button = (sel: string) => stage.querySelector<HTMLButtonElement>(sel);
	const scene = get(".tst-scene");
	const world = get("[data-world]");
	const sets = get("[data-sets]");
	const bo = get("[data-bo]");
	const boWalk = get("[data-bo-walk]");
	const boLeft = get("[data-bo-left]");
	const iris = get("[data-iris]");
	const route = get("[data-route]");
	const routeList = get("[data-marks]");
	const prevBtn = button("[data-prev]");
	const nextBtn = button("[data-next]");
	const pauseBtn = button("[data-pause]");
	const help = get("[data-stage-help]");
	const said = get("[data-stage-said]");
	const toast = stage.ownerDocument.querySelector<HTMLElement>("[data-toast]");
	if (!scene || !world || !sets || !bo || !boWalk || !boLeft || !iris || !route || !routeList || !prevBtn || !nextBtn || !pauseBtn || !help || !said || !toast) {
		return null;
	}
	return { scene, world, sets, bo, boWalk, boLeft, iris, route, routeList, prevBtn, nextBtn, pauseBtn, help, said, toast };
}

function stageOn(page: HTMLElement, stage: HTMLElement): () => void {
	if (!page.querySelector("[data-trail-stop]")) return () => {};
	const ART = readProps(stage);
	const CAST = readCast(stage);
	const band = bandOf(stage);
	if (!band) return () => {};
	const { scene, world, sets, bo, boWalk, boLeft, iris, route, routeList, prevBtn, nextBtn, pauseBtn, help, said, toast } = band;

	let alive = true;
	const timers = new Set<number>();
	const later = (ms: number, fn: () => void): number => {
		const id = window.setTimeout(() => {
			timers.delete(id);
			if (alive) fn();
		}, ms);
		timers.add(id);
		return id;
	};
	const intervals = new Set<number>();
	const cancel = (id: number) => {
		clearTimeout(id);
		timers.delete(id);
	};
	const undo: Array<() => void> = [];
	const ac = new AbortController();
	const signal = ac.signal;
	undo.push(() => ac.abort());
	const made: HTMLElement[] = [];
	const make = (tag: string, cls = "", html = ""): HTMLElement => {
		const n = el(tag, cls, html);
		made.push(n);
		return n;
	};
	const moved: Array<{ node: Element; parent: Element; next: Node | null }> = [];
	const move = (node: Element, host: Element) => {
		if (!node.parentElement) return;
		moved.push({ node, parent: node.parentElement, next: node.nextSibling });
		host.appendChild(node);
	};

	let rm = prefersStill();
	const vw = () => page.clientWidth;
	const vh = () => page.clientHeight;
	let desk = innerWidth >= 900 && innerHeight >= 560;
	page.classList.add("is-staged");
	page.dataset.mode = desk ? "desk" : "phone";
	route.hidden = false;
	help.hidden = false;
	page.appendChild(toast);

	const hobit = (who: string, name: string, cls = ""): HTMLElement => {
		const n = make("span", `tst-hob ${cls}`);
		n.setAttribute("aria-hidden", "true");
		n.style.backgroundImage = `url("${CAST.get(who) ?? ""}")`;
		pose(n, name);
		return n;
	};

	let tilts = 0;
	const tilt = () => [-1.1, 0.8, -0.6, 1.2, -0.9, 0.5][tilts++ % 6];
	const waiting = new Map<number, HTMLImageElement[]>();
	const fetchStop = (i: number) => {
		for (const img of waiting.get(i) ?? []) img.src = img.dataset.src ?? "";
		waiting.delete(i);
	};
	const fetchNear = (i: number) => {
		for (const j of [i, i + 1, i - 1]) fetchStop(j);
	};
	const prop = (art: PropArt, host: HTMLElement, stop: number): HTMLElement => {
		const b = make("span", "tst-prop");
		b.setAttribute("aria-hidden", "true");
		b.style.setProperty("--h", String(art.units));
		const img = new Image();
		img.dataset.src = art.src;
		waiting.set(stop, [...(waiting.get(stop) ?? []), img]);
		img.alt = "";
		img.draggable = false;
		b.appendChild(img);
		b.addEventListener("click", () => say(b, art.say));
		host.appendChild(b);
		return b;
	};
	function say(target: HTMLElement, word: string): void {
		target.classList.remove("is-boinging");
		void target.offsetWidth;
		target.classList.add("is-boinging");
		const host = target.parentElement;
		if (!host || !word) return;
		const w = make("span", "tst-pow", word);
		const r = target.getBoundingClientRect();
		const hr = host.getBoundingClientRect();
		w.style.left = `${r.left - hr.left + r.width * 0.3}px`;
		w.style.top = `${r.top - hr.top - 8}px`;
		host.appendChild(w);
		later(900, () => w.remove());
	}
	const board = (cls: string, host: HTMLElement): Sign => {
		const node = make("div", `tst-board ${cls}`);
		node.appendChild(el("i", "tst-frame"));
		const inner = el("div", "tst-inner");
		node.appendChild(inner);
		node.style.setProperty("--tilt", `${tilt()}deg`);
		host.appendChild(node);
		return { node, inner };
	};

	const pops: Pop[] = [];
	const STOPS: Stop[] = [...page.querySelectorAll<HTMLElement>("[data-trail-stop]")].map((sec, index) => {
		const head = sec.querySelector<HTMLElement>(".stop-head");
		const badge = head?.querySelector(".badge")?.textContent?.trim() ?? "";
		const name = sec.dataset.stopName ?? badge;
		const sign = sec.dataset.stopSign ?? (badge || name);
		const cards = [...sec.querySelectorAll<HTMLElement>(".stop-card")];
		const items: Item[] = [];
		for (const card of cards) {
			const art = ART.get(card.dataset.prop ?? "") ?? null;
			const bare = card.hasAttribute("data-prop-bare");
			items.push({ card: bare ? null : card, art, wide: card.classList.contains("stop-card-wide"), board: null, pnode: null, dprop: null, x: 0, w: 0, want: card.classList.contains("stop-card-wide") ? 520 : card.classList.contains("terminal-wrap") ? 430 : 310, on: false });
		}
		const set = make("div", "tst-set");
		set.setAttribute("aria-hidden", "true");
		sets.appendChild(set);
		const { node: signNode, inner } = board("tst-placard tst-sign", set);
		inner.textContent = sign;
		let n = 1;
		for (const it of items) {
			if (!it.art) continue;
			it.dprop = prop(it.art, set, index);
			it.dprop.classList.add("tst-fold");
			it.dprop.style.setProperty("--n", String(n++));
		}
		const parts = [...(head ? [head] : []), ...cards];
		const title = sec.querySelector("h1, h2")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		return { key: sec.dataset.trailStop ?? "", name, title, sign, sec, head, items, extra: extraOf(sec.dataset.stopExtra), set, signNode, folds: n, parts, cards: items.flatMap((it) => (it.card ? [it.card] : [])), bb: null, pos: 0, anchor: 0, gone: 0, cue: 0 };
	});

	if (!desk) {
		for (const s of STOPS) {
			const lead = s.head ?? s.sec.querySelector<HTMLElement>(".stop-card");
			if (lead) {
				const { node, inner } = board("tst-billboard", world);
				move(lead, inner);
				s.bb = { node, x: 0, w: 0, want: s.sec.classList.contains("stop-hero") ? 540 : 460, on: false };
				pops.push(s.bb);
			}
			for (const it of s.items) {
				if (it.card && it.card !== lead) {
					const { node, inner } = board("tst-placard", world);
					move(it.card, inner);
					it.board = node;
					pops.push({ node, x: 0, w: 0, want: it.want, on: false });
				}
				if (it.art) it.pnode = prop(it.art, world, STOPS.indexOf(s));
			}
		}
	}

	type RoadExtra = { stop: Stop; kind: ExtraKind; at: number; node: HTMLElement; w: number; x: number; cart: Cart | null };
	const road: RoadExtra[] = [];
	const stagedTuck: { node: HTMLElement; stop: Stop; fits: boolean }[] = [];
	const stagedCog: { cart: Cart; stop: Stop; fits: boolean }[] = [];
	const cartOf = (host: HTMLElement, stop: number): Cart | null => {
		const art = ART.get("handcar");
		if (!art) return null;
		const node = make("div", "tst-cart");
		node.setAttribute("aria-hidden", "true");
		const car = prop(art, node, stop);
		car.style.left = "0px";
		const rider = hobit("cog", "stand", "tst-rider");
		rider.style.zIndex = "2";
		node.insertBefore(rider, car);
		host.appendChild(node);
		return { node, rider, gone: false };
	};
	for (const s of STOPS) {
		if (s.extra === "hint" && !desk) {
			const { node, inner } = board("tst-placard tst-hint is-up", world);
			inner.innerHTML = "<b>This way →</b><span>swipe, or use the arrows</span>";
			node.setAttribute("aria-hidden", "true");
			road.push({ stop: s, kind: "hint", at: 0.42, node, w: 230, x: 0, cart: null });
		} else if (s.extra === "tuck") {
			if (!desk) {
				const node = hobit("tuck", "doze");
				world.appendChild(node);
				node.addEventListener("click", () => wake(node, true));
				road.push({ stop: s, kind: "tuck", at: 0.5, node, w: 0, x: 0, cart: null });
			} else {
				const node = hobit("tuck", "doze", "tst-fold");
				node.style.setProperty("--n", String(s.folds));
				s.set.appendChild(node);
				node.addEventListener("click", () => wake(node, true));
				stagedTuck.push({ node, stop: s, fits: false });
			}
		} else if (s.extra === "cog") {
			const cart = cartOf(desk ? s.set : world, STOPS.indexOf(s));
			if (cart) {
				if (!desk) road.push({ stop: s, kind: "cog", at: 0.4, node: cart.node, w: 0, x: 0, cart });
				else {
					for (const n of cart.node.children) if (n instanceof HTMLElement) {
						n.classList.add("tst-fold");
						n.style.setProperty("--n", String(s.folds));
					}
					stagedCog.push({ cart, stop: s, fits: false });
				}
			}
		}
	}

	const found = new Set<string>();
	const stamps = page.querySelector<HTMLElement>("[data-stamps]");
	if (stamps) stamps.hidden = false;
	let toastTimer = 0;
	function meet(who: string): void {
		if (found.has(who)) return;
		found.add(who);
		for (const st of page.querySelectorAll<HTMLElement>(`[data-stamps] [data-who="${who}"]`)) {
			st.classList.add("is-got");
			st.setAttribute("aria-label", `Met ${who}`);
		}
		toast.innerHTML = "";
		const badge = el("span", "stamp is-got");
		const face = el("i");
		face.style.backgroundImage = `url("${CAST.get(who) ?? ""}")`;
		badge.appendChild(face);
		const words = el("span", "", `<b>Stamp collected</b>${HOBITS.get(who) ?? ""} ${found.size} of ${HOBITS.size}.`);
		toast.append(badge, words);
		toast.classList.add("is-shown");
		cancel(toastTimer);
		toastTimer = later(4200, () => toast.classList.remove("is-shown"));
	}

	const cam = { x: 0, v: 0, a: 0, c: [0, 0, 0, 0, 0, 0], moving: false, t0: 0, T: 0, to: 0 };
	function glide(to: number, T: number): void {
		const d = to - cam.x;
		const { v, a } = cam;
		cam.c = [
			cam.x,
			v,
			a / 2,
			(20 * d - 12 * v * T - 3 * a * T * T) / (2 * T ** 3),
			(-30 * d + 16 * v * T + 3 * a * T * T) / (2 * T ** 4),
			(12 * d - 6 * v * T - a * T * T) / (2 * T ** 5),
		];
		cam.moving = true;
		cam.t0 = now();
		cam.T = T;
		cam.to = to;
	}
	function camStep(n: number): void {
		if (!cam.moving) return;
		const t = Math.min((n - cam.t0) / 1000, cam.T);
		const c = cam.c;
		cam.x = c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
		cam.v = c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + t * 5 * c[5])));
		cam.a = 2 * c[2] + t * (6 * c[3] + t * (12 * c[4] + t * 20 * c[5]));
		if (t >= cam.T) {
			cam.x = cam.to;
			cam.v = 0;
			cam.a = 0;
			cam.moving = false;
		}
	}
	const camSet = (x: number) => {
		cam.x = x;
		cam.to = x;
		cam.v = 0;
		cam.a = 0;
		cam.moving = false;
	};
	const heading = () => (cam.moving ? cam.to : cam.x);

	const PS = 0.78;
	let boX = 0;
	let H = 0;
	let D = 560;
	let beats = [0];
	let maxPos = 0;
	let active = 0;
	const plates = [...stage.querySelectorAll<HTMLElement>("[data-plate]")].map((node) => ({ node, speed: Number(node.dataset.speed ?? "1"), aspect: Number(node.dataset.aspect ?? "4"), tile: 0 }));
	const size = (art: PropArt, u: number): [number, number] => {
		const ph = art.units * u * PS;
		return [ph * art.aspect, ph];
	};
	function layout(): void {
		H = parseFloat(getComputedStyle(page).getPropertyValue("--H")) || 240;
		const probe = plates[0]?.node.getBoundingClientRect().height;
		if (probe) H = probe;
		const u = H / 300;
		const base = H * 0.14;
		for (const q of plates) q.tile = Math.round(q.aspect * H);
		if (desk) deskLayout(u);
		else phoneLayout(u, base);
		bo?.style.setProperty("--bo-x", `${boX}px`);
		cloudLayout();
		routeAt = -1;
	}
	function deskLayout(u: number): void {
		const w = vw();
		const left = page.getBoundingClientRect().left;
		const wrap = STOPS[0].sec.querySelector(".container")?.getBoundingClientRect();
		const wrapLeft = wrap ? wrap.left - left + 24 : Math.max(24, (w - 1120) / 2 + 24);
		boX = Math.round(clamp(wrapLeft - 20, 110, 220));
		D = Math.round(clamp(w * 0.4, 480, 640));
		for (const s of STOPS) {
			const sw = s.signNode.offsetWidth;
			const beside = H < 200;
			const reach = u * 128 * (554 / 542) * 0.42;
			s.signNode.classList.toggle("is-beside", beside);
			s.signNode.style.left = `${beside ? boX + reach : boX - sw / 2}px`;
			let floor = beside ? boX + reach + sw + 30 : boX + Math.max(sw / 2, 60) + 34;
			s.items.forEach((it, n) => {
				if (!it.art || !it.dprop) return;
				const [pw] = size(it.art, u);
				let centre = w * (0.7 + 0.2 * n);
				if (it.card) {
					const r = it.card.getBoundingClientRect();
					centre = r.left - left + r.width * (it.wide ? 0.78 : 0.5);
				}
				const x = Math.max(centre - pw / 2, floor);
				it.dprop.style.left = `${x}px`;
				floor = x + pw + 36;
			});
			const need = 150 * u + 24;
			const room = w - floor - 16;
			for (const g of stagedTuck) if (g.stop === s) {
				g.fits = room > need;
				g.node.style.display = g.fits ? "" : "none";
				g.node.style.left = `${w - need}px`;
			}
			for (const g of stagedCog) if (g.stop === s) {
				g.fits = room > need;
				g.cart.node.style.display = g.fits ? "" : "none";
				g.cart.node.style.left = `${w - need}px`;
				g.cart.rider.style.left = `${4 * u}px`;
				g.cart.rider.style.bottom = `calc(var(--base) + ${48 * u * PS}px)`;
			}
		}
	}
	function phoneLayout(u: number, base: number): void {
		const w = vw();
		boX = Math.round(Math.max(64, w * 0.17));
		const gap = 44;
		const gapStop = w + 180;
		const beatAt = (x: number, bw: number) => x + boX - (w - bw) / 2;
		const raw: number[] = [];
		let x = 16 - boX;
		for (const s of STOPS) {
			const first = raw.length;
			if (s.bb) {
				s.bb.w = Math.min(s.bb.want, w - 32);
				s.bb.x = x;
				s.bb.node.style.left = `${x}px`;
				s.bb.node.style.width = `${s.bb.w}px`;
				raw.push(beatAt(x, s.bb.w));
				x += s.bb.w + gap;
			}
			for (const it of s.items) {
				const [pw, ph] = it.art ? size(it.art, u) : [0, 0];
				it.x = x;
				if (!it.board) {
					if (it.pnode) {
						it.w = pw;
						it.pnode.style.left = `${x}px`;
						x += pw + gap;
					}
					continue;
				}
				it.w = Math.min(it.want, w - 32);
				it.board.style.left = `${x}px`;
				it.board.style.width = `${it.w}px`;
				const pop = pops.find((p) => p.node === it.board);
				if (pop) {
					pop.x = x;
					pop.w = it.w;
				}
				raw.push(beatAt(x, it.w));
				if (it.pnode) {
					it.board.style.setProperty("--b", `${Math.round(base + ph + 16)}px`);
					it.pnode.style.left = `${x + it.w - pw + 44}px`;
				}
				x += Math.max(it.w, pw) + gap;
			}
			const end = x - gap;
			s.pos = Math.round(raw[first] ?? x);
			for (const g of road) if (g.stop === s) {
				g.x = end + gapStop * g.at;
				g.node.style.left = `${g.x}px`;
				if (g.kind === "hint") g.node.style.width = `${g.w}px`;
				if (g.cart) {
					g.cart.rider.style.left = `${4 * u}px`;
					g.cart.rider.style.bottom = `calc(var(--base) + ${48 * u * PS}px)`;
				}
			}
			x = end + gapStop;
		}
		beats = raw.map(Math.round).filter((b, i, a) => i === 0 || b - a[i - 1] > 140);
		maxPos = beats[beats.length - 1] ?? 0;
		markTallSigns();
	}

	const clouds = [...stage.querySelectorAll<HTMLElement>("[data-cloud]")].map((node, i) => {
		const squash = () => {
			node.classList.remove("is-squashed");
			void node.offsetWidth;
			node.classList.add("is-squashed");
		};
		node.addEventListener("click", squash, { signal });
		return { node, w: 0, seed: i * 0.143 + 0.05, row: [0.08, 0.3, 0.16, 0.42, 0.24, 0.04, 0.36][i] ?? 0.2, size: [1, 0.7, 0.8, 1.15, 0.6, 0.9, 0.75][i] ?? 1, speed: 0.1 + (i % 3) * 0.05, drift: 5 + (i % 4) * 3 };
	});
	function cloudLayout(): void {
		const top = 120;
		const sky = Math.max(80, vh() - H * 0.7 - top);
		for (const c of clouds) {
			c.w = Math.round((desk ? clamp(H * 0.34, 64, 110) : clamp(vw() * 0.28, 110, 180)) * c.size);
			c.node.style.width = `${c.w}px`;
			c.node.style.top = desk ? `${64 + H * 0.2 * c.row}px` : `${top + sky * c.row}px`;
			c.node.style.bottom = "";
		}
	}

	const OUT = "cubic-bezier(.5, 0, .75, .4)";
	const IN = "cubic-bezier(.16, 1, .3, 1)";
	let pageBusy = false;
	let pending: number | null = null;
	let steps = 0;
	function handOver(from: number, to: number, dir: number): void {
		const A = STOPS[from];
		const B = STOPS[to];
		B.sec.classList.add("is-on");
		if (rm) {
			A.sec.classList.remove("is-on");
			return;
		}
		pageBusy = true;
		A.parts.forEach((n, i) =>
			n.animate(
				[
					{ transform: "translate3d(0,0,0)", opacity: 1, filter: "blur(0px)" },
					{ transform: `translate3d(${-dir * (9 + i * 1.5)}vw,0,0)`, opacity: 0, filter: "blur(7px)" },
				],
				{ duration: 420, delay: i * 28, easing: OUT, fill: "forwards" },
			),
		);
		let last: Animation | null = null;
		for (const [i, n] of B.parts.entries()) {
			last = n.animate(
				[
					{ transform: `translate3d(${dir * (13 + i * 2.5)}vw,0,0)`, opacity: 0, filter: "blur(7px)" },
					{ transform: "translate3d(0,0,0)", opacity: 1, filter: "blur(0px)" },
				],
				{ duration: 760, delay: 170 + i * 60, easing: IN, fill: "backwards" },
			);
		}
		const done = () => {
			if (!alive) return;
			A.sec.classList.remove("is-on");
			for (const n of A.parts) for (const x of n.getAnimations()) x.cancel();
			pageBusy = false;
			if (pending !== null) {
				const p = pending;
				pending = null;
				goStop(p, pendingFocus);
			}
		};
		if (last) last.finished.then(done, () => (pageBusy = false));
		else done();
	}
	function leave(s: Stop): void {
		s.set.classList.remove("is-live");
		s.signNode.classList.remove("is-up");
		cancel(s.gone);
		s.gone = later(700, () => {
			if (!s.set.classList.contains("is-live")) s.set.classList.remove("is-alive");
		});
		cancel(s.cue);
	}
	function enter(s: Stop, anchor: number, wait: number): void {
		cancel(s.gone);
		s.anchor = anchor;
		s.set.classList.add("is-alive");
		s.set.style.transform = `translate3d(${anchor - cam.x}px,0,0)`;
		later(wait, () => {
			if (STOPS[active] === s) {
				s.set.classList.add("is-live");
				s.signNode.classList.add("is-up");
			}
		});
		s.cue = later(wait + 1500, () => {
			if (STOPS[active] !== s) return;
			for (const g of stagedTuck) if (g.stop === s && g.fits) wake(g.node, false);
			for (const g of stagedCog) if (g.stop === s && g.fits) rideOff(g.cart);
		});
	}
	function announce(i: number, aloud = true): void {
		const s = STOPS[i];
		if (aloud) said.textContent = `${i + 1} of ${STOPS.length}, ${s.name}: ${s.title}`;
		const url = `${location.pathname}${location.search}${hashForStop(i, s.sec.id)}`;
		if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", url);
	}
	function measureFit(s: Stop): void {
		const inner = s.sec.querySelector<HTMLElement>(":scope > .container");
		const tall = desk && inner !== null && !fits(inner.scrollHeight, s.sec.clientHeight);
		s.sec.classList.toggle("is-tall", tall);
		s.sec.classList.toggle("has-more", tall && canScroll(1, s.sec.scrollTop, s.sec.scrollHeight, s.sec.clientHeight));
	}
	function markTallSigns(): void {
		for (const inner of world.querySelectorAll<HTMLElement>(".tst-inner")) {
			inner.classList.remove("is-tall");
			inner.classList.toggle("is-tall", inner.scrollHeight > inner.clientHeight + 1);
		}
		for (const wrap of world.querySelectorAll<HTMLElement>(".table-wrap")) markMoreSides(wrap);
	}
	function markMoreSides(wrap: HTMLElement): void {
		const more = moreSides(wrap.scrollLeft, wrap.scrollWidth, wrap.clientWidth);
		if (more) wrap.dataset.more = more;
		else delete wrap.dataset.more;
	}
	const reading = () => (desk ? STOPS[active].sec : null);
	let pendingFocus = false;
	function goStop(want: number, carry = false): void {
		const j = clampStop(want, STOPS.length);
		if (j === active) return;
		const focusIn = carry && STOPS[active].sec.contains(document.activeElement);
		if (pageBusy) {
			pending = j;
			pendingFocus = pendingFocus || focusIn;
			return;
		}
		hintOff();
		flee();
		const from = active;
		const dir = j > from ? 1 : -1;
		active = j;
		const carried = focusIn || pendingFocus;
		// A heading that takes focus is read out by itself; the live region
		announce(j, !carried);
		fetchNear(j);
		STOPS[j].sec.scrollTop = 0;
		const land = () => {
			measureFit(STOPS[j]);
			if (!carried) return;
			pendingFocus = false;
			const h = STOPS[j].sec.querySelector<HTMLElement>("h1, h2");
			if (!h) return;
			h.tabIndex = -1;
			h.focus({ preventScroll: true });
		};
		if (rm) {
			leave(STOPS[from]);
			STOPS[from].set.classList.remove("is-alive");
			enter(STOPS[j], cam.x, 0);
			handOver(from, j, dir);
			land();
			return;
		}
		const anchor = heading() + D * dir;
		leave(STOPS[from]);
		enter(STOPS[j], anchor, 520);
		glide(anchor, 1.6);
		handOver(from, j, dir);
		land();
		if (dir > 0 && ++steps % 3 === 2) race();
	}

	let trip: { to: number; t0: number; R: number; swapped: boolean } | null = null;
	const stopAt = (p: number) => {
		let i = 0;
		while (i < STOPS.length - 1 && p >= STOPS[i + 1].pos - 1) i++;
		return i;
	};
	const nearest = (p: number) => beats.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a), beats[0]);
	function walkTo(want: number): void {
		const p = clamp(want, 0, maxPos);
		const dist = Math.abs(p - cam.x);
		if (dist < 1 || trip) return;
		hintOff();
		flee();
		if (rm) {
			camSet(p);
			return;
		}
		if (dist > vw() * 3.2) {
			trip = { to: p, t0: now(), R: Math.hypot(vw(), vh()), swapped: false };
			return;
		}
		glide(p, clamp(dist / 430, 1, 2.3));
		if (p > cam.x && dist > vw() * 0.7 && ++steps % 3 === 2) race();
	}

	const atTop = () => inStageZone(scrollY, page.offsetHeight);
	const settle = () => {
		if (scrollY > 0) scrollTo({ top: 0, behavior: "auto" });
	};
	const atEnd = () => (desk ? (pending ?? active) >= STOPS.length - 1 : heading() >= maxPos - 1);
	const atStart = () => (desk ? (pending ?? active) <= 0 : heading() <= 1);
	function step(dir: number, carry = false): void {
		settle();
		if (desk) {
			goStop((pending ?? active) + dir, carry);
			return;
		}
		const from = heading();
		const next = dir > 0 ? beats.find((b) => b > from + 4) : [...beats].reverse().find((b) => b < from - 4);
		if (next !== undefined && !(cam.moving && Math.abs(cam.to - cam.x) > vw())) {
			trip = null;
			walkTo(next);
		}
	}
	const goSection = (i: number) => (desk ? goStop(i) : walkTo(STOPS[i].pos));
	const toFooter = () => {
		document.querySelector(".site-footer, footer")?.scrollIntoView({ behavior: rm ? "auto" : "smooth", block: "start" });
	};
	const takes = (dir: number) => trailTakes(atTop(), dir, atStart(), atEnd());

	let lastWheel = Number.NEGATIVE_INFINITY;
	let gesture = { acc: 0, fired: false, stepped: false, fromPage: false, peak: 0, last: 0 };
	const wheelDelta = (e: WheelEvent) => (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 32 : 1);
	addEventListener("wheel", (e) => {
		const d = Math.abs(wheelDelta(e));
		const n = now();
		if (startsGesture(n - lastWheel, d, gesture.last, gesture.peak)) {
			gesture = { acc: 0, fired: false, stepped: false, fromPage: !atTop(), peak: 0, last: 0 };
		}
		lastWheel = n;
		gesture.peak = Math.max(gesture.peak, d);
		gesture.last = d;
	}, { capture: true, passive: true, signal });
	page.addEventListener("wheel", (e) => {
		const d = wheelDelta(e);
		const dir = Math.sign(d);
		if (gesture.fromPage) {
			e.preventDefault();
			if (scrollY > 0) scrollBy({ top: d, behavior: "instant" });
			return;
		}
		if (gesture.stepped) {
			e.preventDefault();
			return;
		}
		const sign = e.target instanceof Element ? e.target.closest(".tst-world .tst-inner") : null;
		if (sign && canScroll(dir, sign.scrollTop, sign.scrollHeight, sign.clientHeight)) return;
		const box = reading();
		if (atTop() && !pageBusy && box && canScroll(dir, box.scrollTop, box.scrollHeight, box.clientHeight)) {
			e.preventDefault();
			box.scrollTop += d;
			gesture.fired = true;
			return;
		}
		if (!takes(dir)) return;
		e.preventDefault();
		if (gesture.fired) return;
		gesture.acc += d;
		if (Math.abs(gesture.acc) > 20) {
			gesture.fired = true;
			gesture.stepped = true;
			step(Math.sign(gesture.acc));
		}
	}, { passive: false, signal });

	addEventListener("keydown", (e) => {
		const k = e.key;
		if (e.altKey || e.ctrlKey || e.metaKey || pageKeepsKey(keyPlace(e.target), k)) return;
		const free = e.target === document.body || e.target === page;
		const dir = keyDirection(k, e.shiftKey, free);
		if (dir !== 0) {
			if (!atTop()) return;
			const box = reading();
			if (readsDown(k) && box && canScroll(dir, box.scrollTop, box.scrollHeight, box.clientHeight)) {
				box.scrollBy({ top: dir * scrollAmount(k, box.clientHeight), behavior: rm ? "auto" : "smooth" });
				e.preventDefault();
				return;
			}
			if (!takes(dir)) return;
			step(dir, true);
			e.preventDefault();
		} else if ((k === "Home" || k === "End") && atTop()) {
			goSection(k === "Home" ? 0 : STOPS.length - 1);
			e.preventDefault();
		}
	}, { signal });

	let down: { x: number; y: number; id: number; moved: boolean } | null = null;
	let suppressClick = false;
	page.addEventListener("pointerdown", (e) => {
		if (e.button || desk) return;
		down = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
	}, { signal });
	page.addEventListener("pointermove", (e) => {
		if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
	}, { signal });
	const lift = (e: PointerEvent) => {
		if (!down || e.pointerId !== down.id) return;
		const dx = e.clientX - down.x;
		const dy = e.clientY - down.y;
		const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
		if (down.moved) {
			suppressClick = true;
			later(0, () => (suppressClick = false));
		}
		down = null;
		if (e.type !== "pointerup" || Math.abs(d) <= 44) return;
		const dir = d < 0 ? 1 : -1;
		if (!atTop()) {
			if (dir < 0) scrollTo({ top: 0, behavior: rm ? "auto" : "smooth" });
		} else if (takes(dir)) step(dir);
		else if (dir > 0) toFooter();
	};
	page.addEventListener("pointerup", lift, { signal });
	page.addEventListener("pointercancel", lift, { signal });
	page.addEventListener("click", (e) => {
		if (suppressClick) {
			e.preventDefault();
			e.stopPropagation();
		}
	}, { capture: true, signal });

	world.addEventListener("focusin", (e) => {
		if (desk || !(e.target instanceof Element)) return;
		const b = e.target.closest(".tst-board");
		const o = pops.find((q) => q.node === b);
		if (o) walkTo(nearest(o.x + boX - (vw() - o.w) / 2));
	}, { signal });

	const hop = () => {
		bo.classList.remove("is-hopping", "is-landing");
		void bo.offsetWidth;
		bo.classList.add("is-hopping");
		const w = make("span", "tst-pow", "BOING");
		const r = bo.getBoundingClientRect();
		const hr = scene.getBoundingClientRect();
		w.style.left = `${r.left - hr.left + r.width * 0.5}px`;
		w.style.top = `${r.top - hr.top - 26}px`;
		scene.appendChild(w);
		later(900, () => w.remove());
	};
	bo.addEventListener("click", hop, { signal });

	const you = make("i", "tst-you");
	you.setAttribute("aria-hidden", "true");
	const marks = STOPS.map((s, i) => {
		const li = make("li");
		const b = el("button", "tst-mark");
		b.setAttribute("type", "button");
		b.setAttribute("aria-label", `Go to ${s.name}`);
		b.addEventListener("click", () => goSection(i));
		const label = el("span", "", "");
		label.textContent = s.name;
		label.setAttribute("aria-hidden", "true");
		li.append(b, label);
		routeList.appendChild(li);
		return { li, b };
	});
	routeList.appendChild(you);
	const prev = () => step(-1, true);
	const next = () => (atEnd() ? toFooter() : step(1, true));
	prevBtn.addEventListener("click", prev, { signal });
	nextBtn.addEventListener("click", next, { signal });
	let hinted = true;
	let routeAt = -1;
	let youAt = 0;
	function hintOff(): void {
		if (!hinted) return;
		hinted = false;
		nextBtn?.classList.remove("is-nudging");
	}
	function routeDraw(dt: number): void {
		let at: number;
		let want: number;
		if (desk) {
			at = pending ?? active;
			want = active;
		} else {
			const i = stopAt(cam.x);
			const a = STOPS[i].pos;
			const b = i < STOPS.length - 1 ? STOPS[i + 1].pos : a + 1;
			want = i + clamp((cam.x - a) / (b - a || 1), 0, 1);
			at = stopAt(trip ? trip.to : heading());
		}
		youAt = desk && !rm ? youAt + (want - youAt) * (1 - Math.exp(-dt * 4.2)) : want;
		you.style.left = `calc(8px + (100% - 16px) * ${(youAt / Math.max(1, STOPS.length - 1)).toFixed(4)})`;
		if (prevBtn) prevBtn.disabled = at <= 0 && (desk || heading() <= 0);
		if (at === routeAt) return;
		if (!desk && routeAt !== -1) announce(at);
		if (!desk) fetchNear(at);
		routeAt = at;
		marks.forEach((m, n) => {
			m.b.classList.toggle("is-past", n < at);
			m.li.classList.toggle("is-current", n === at);
			if (n === at) m.b.setAttribute("aria-current", "step");
			else m.b.removeAttribute("aria-current");
		});
	}

	const awake = new WeakSet<HTMLElement>();
	function wake(node: HTMLElement, clicked: boolean): void {
		if (awake.has(node) && !clicked) return;
		awake.add(node);
		meet("tuck");
		if (rm) {
			pose(node, "wave");
			return;
		}
		pose(node, "startled");
		later(320, () => pose(node, "wave"));
		later(1900, () => pose(node, "stand"));
		later(2600, () => pose(node, "blink"));
		later(2800, () => pose(node, "stand"));
	}
	function rideOff(g: Cart): void {
		if (g.gone) return;
		g.gone = true;
		meet("cog");
		pose(g.rider, "wave");
		if (!rm) {
			g.node.style.transform = `translateX(${Math.round(Math.min(620, vw() * 0.5))}px)`;
			later(2800, () => pose(g.rider, "stand"));
		}
	}
	let peeker: { n: HTMLElement; ids: number[] } | null = null;
	let peeks = 0;
	let nextPeek = 2600;
	let stillAt = 0;
	function tryPeek(): void {
		if (isStill() || peeker || peeks >= 5) return;
		const n = hobit("mags", "stand", "is-peeking");
		if (desk) {
			const s = STOPS[active];
			s.sec.appendChild(n);
			const c = n.offsetHeight;
			const ok = s.cards.filter((card) => {
				const grid = card.parentElement;
				const prevBlock = grid?.classList.contains("grid") ? grid.previousElementSibling : null;
				const clear = prevBlock instanceof HTMLElement && grid ? grid.offsetTop - (prevBlock.offsetTop + prevBlock.offsetHeight) : card.offsetTop;
				return card.offsetHeight >= c && clear >= c * 0.62;
			});
			if (!ok.length) {
				n.remove();
				stillAt = now();
				return;
			}
			const card = ok[Math.floor(Math.random() * ok.length)];
			const r = card.getBoundingClientRect();
			const sr = s.sec.getBoundingClientRect();
			n.style.left = `${r.left - sr.left + r.width * (0.2 + Math.random() * 0.5)}px`;
			n.style.top = `${r.top - sr.top}px`;
		} else {
			const c = 150 * (H / 300);
			const top = 120 + c * 0.62;
			const ok = pops
				.filter((q) => q.node.classList.contains("is-up"))
				.map((q) => ({ q, r: q.node.getBoundingClientRect() }))
				.filter(({ r }) => r.left > 12 && r.right < vw() - 12 && r.top > top && r.height > c);
			if (!ok.length) {
				n.remove();
				return;
			}
			const { q, r } = ok[Math.floor(Math.random() * ok.length)];
			const pr = page.getBoundingClientRect();
			n.style.left = `${q.x + q.w * (0.15 + Math.random() * 0.5)}px`;
			n.style.top = `${Math.round(r.top - pr.top)}px`;
			world.appendChild(n);
		}
		const ids: number[] = [];
		peeker = { n, ids };
		peeks++;
		nextPeek = 9000 + Math.random() * 6000;
		requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add("is-out")));
		const at = (ms: number, fn: () => void) => ids.push(later(ms, fn));
		at(450, () => meet("mags"));
		at(700, () => pose(n, "lookLeft"));
		at(1350, () => pose(n, "lookRight"));
		at(2000, () => pose(n, "blink"));
		at(2200, () => pose(n, "wave"));
		at(3300, () => pose(n, "stand"));
		at(3700, () => n.classList.remove("is-out"));
		at(4300, () => {
			n.remove();
			peeker = null;
			stillAt = now();
		});
	}
	function flee(): void {
		if (!peeker) return;
		const { n, ids } = peeker;
		for (const id of ids) cancel(id);
		peeker = null;
		pose(n, "startled");
		n.classList.add("is-fleeing");
		n.classList.remove("is-out");
		later(200, () => n.remove());
	}
	function race(): void {
		if (rm || isStill()) return;
		meet("pip");
		const n = hobit("pip", "run", "tst-runner");
		scene?.appendChild(n);
		let f = 0;
		const t = window.setInterval(() => pose(n, ++f % 2 ? "runB" : "run"), 90);
		intervals.add(t);
		const stop = () => {
			clearInterval(t);
			intervals.delete(t);
		};
		n.addEventListener("animationend", () => {
			stop();
			n.remove();
		});
		later(2000, stop);
	}

	const syncPause = () => {
		rm = prefersStill();
		pauseBtn.hidden = rm;
		pauseBtn.setAttribute("aria-pressed", String(isPaused()));
		if (isStill()) flee();
	};
	const togglePause = () => setPaused(!isPaused());
	pauseBtn.addEventListener("click", togglePause, { signal });
	undo.push(onMotionChange(syncPause));
	syncPause();

	let facing = 1;
	let walking = false;
	let strideAt = 0;
	let lastX = 0;
	let lastT = 0;
	let raf = 0;
	let wasEnd = false;
	function irisFrame(n: number): void {
		if (!trip) return;
		const k = n - trip.t0;
		const r0 = trip.R;
		let r = 0;
		if (k < 460) r = r0 * (1 - (k / 460) ** 2.4);
		else if (k < 600) {
			if (!trip.swapped) {
				trip.swapped = true;
				camSet(trip.to);
				lastX = cam.x;
			}
		} else if (k < 1180) r = r0 * (1 - (1 - (k - 600) / 580) ** 2.4);
		else {
			trip = null;
			if (iris) iris.hidden = true;
			stillAt = n;
			return;
		}
		if (!iris) return;
		iris.hidden = false;
		const cy = (scene?.clientHeight ?? 0) - H * 0.107 - 128 * (H / 300) * 0.5;
		iris.style.background = `radial-gradient(circle at ${boX}px ${cy}px, transparent ${r}px, var(--ink) ${r + 2}px)`;
	}
	function frame(t: number): void {
		if (!alive) return;
		const n = now();
		const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
		lastT = t;
		if (trip) irisFrame(n);
		else camStep(n);
		const x = cam.x;
		for (const q of plates) if (q.tile > 0) q.node.style.transform = `translate3d(${-((((x * q.speed) % q.tile) + q.tile) % q.tile)}px,0,0)`;
		if (desk) {
			for (const s of STOPS) if (s.set.classList.contains("is-alive")) s.set.style.transform = `translate3d(${s.anchor - x}px,0,0)`;
		} else {
			world.style.transform = `translate3d(${boX - x}px,0,0)`;
			const upAt = vw() * 0.92;
			const downAt = vw() * 0.03;
			for (const q of pops) {
				const left = q.x + boX - x;
				const shown = left < upAt && left + q.w > downAt;
				if (shown !== q.on) {
					q.on = shown;
					q.node.classList.toggle("is-up", shown);
				}
			}
			for (const g of road) {
				if (g.kind === "tuck" && Math.abs(g.x - x) < 170) wake(g.node, false);
				if (g.cart && g.x - x < 280 && g.x - x > -200) rideOff(g.cart);
			}
		}
		const moving = Math.abs(cam.v) > 14;
		if (moving) facing = cam.v > 0 ? 1 : -1;
		strideAt += Math.min(Math.abs(x - lastX) / ((13 * H) / 300), 30 * dt);
		lastX = x;
		const f = Math.floor(strideAt) % 36;
		const sheet = facing > 0 ? boWalk : boLeft;
		if (sheet) sheet.style.backgroundPosition = `${(f % 6) * 20}% ${Math.floor(f / 6) * 20}%`;
		if (moving && !walking) {
			walking = true;
			bo?.classList.remove("is-idle", "is-landing");
			bo?.classList.toggle("is-left", facing < 0);
		} else if (moving && walking) bo?.classList.toggle("is-left", facing < 0);
		else if (!moving && walking && !cam.moving) {
			walking = false;
			stillAt = n;
			bo?.classList.remove("is-left");
			bo?.classList.add("is-idle");
			if (!rm && bo) {
				void bo.offsetWidth;
				bo.classList.add("is-landing");
			}
		} else if (!walking && !trip && !pageBusy && n - stillAt > nextPeek && atTop()) tryPeek();
		const drifting = !isStill();
		for (const c of clouds) {
			const span = vw() + c.w + 160;
			const cx = ((((c.seed * span - x * c.speed - (drifting ? (t / 1000) * c.drift : 0)) % span) + span) % span) - c.w;
			c.node.style.transform = `translate3d(${cx}px,0,0)`;
		}
		routeDraw(dt);
		const travel = cam.moving || trip !== null || pageBusy ? "moving" : "still";
		if (page.dataset.travel !== travel) page.dataset.travel = travel;
		const end = atEnd();
		if (end !== wasEnd) {
			wasEnd = end;
			nextBtn.setAttribute("aria-label", end ? "To the page footer" : "Next section");
		}
		raf = requestAnimationFrame(frame);
	}

	function reset(i: number): void {
		trip = null;
		if (iris) iris.hidden = true;
		pending = null;
		pageBusy = false;
		flee();
		for (const s of STOPS) {
			s.sec.classList.remove("is-on");
			for (const p of s.parts) for (const a of p.getAnimations()) a.cancel();
			s.set.classList.remove("is-alive", "is-live");
			s.signNode.classList.remove("is-up");
		}
		layout();
		active = i;
		youAt = i;
		STOPS[i].sec.classList.add("is-on");
		fetchNear(i);
		for (const s of STOPS) measureFit(s);
		if (desk) {
			camSet(cam.x);
			enter(STOPS[i], cam.x, 0);
		} else camSet(STOPS[i].pos);
		lastX = cam.x;
	}
	for (const s of STOPS) s.sec.addEventListener("scroll", () => measureFit(s), { passive: true, signal });
	world.addEventListener(
		"scroll",
		(e) => {
			if (e.target instanceof HTMLElement && e.target.matches(".table-wrap")) markMoreSides(e.target);
		},
		{ capture: true, passive: true, signal },
	);
	let resizeTimer = 0;
	addEventListener("resize", () => {
		cancel(resizeTimer);
		resizeTimer = later(80, () => reset(desk ? active : stopAt(cam.x)));
	}, { signal });

	const named = STOPS.map((s) => ({ id: s.sec.id, inner: [...s.sec.querySelectorAll("[id]")].map((n) => n.id) }));
	const hashed = stopFromHash(location.hash, named);
	addEventListener("hashchange", () => {
		const i = stopFromHash(location.hash, named);
		if (i < 0) return;
		settle();
		goSection(i);
	}, { signal });
	reset(Math.max(0, hashed));
	settle();
	const idle = () => {
		for (const i of waiting.keys()) fetchStop(i);
	};
	if ("requestIdleCallback" in window) requestIdleCallback(idle, { timeout: 4000 });
	else later(2500, idle);
	bo.classList.add("is-idle");
	stillAt = now();
	document.fonts?.ready.then(() => {
		if (alive && !cam.moving && !trip && !pageBusy) reset(desk ? active : stopAt(cam.x));
	});
	raf = requestAnimationFrame(frame);

	const wasDesk = desk;
	const modeWatch = () => {
		const isDesk = innerWidth >= 900 && innerHeight >= 560;
		if (isDesk !== wasDesk) {
			teardown();
			const again = stageOn(page, stage);
			rebuilt = again;
		}
	};
	let rebuilt: (() => void) | null = null;
	addEventListener("resize", modeWatch, { signal });

	function teardown(): void {
		if (!alive) return;
		alive = false;
		cancelAnimationFrame(raf);
		for (const id of timers) clearTimeout(id);
		timers.clear();
		for (const id of intervals) clearInterval(id);
		intervals.clear();
		for (const fn of undo) fn();
		for (const s of STOPS) for (const p of s.parts) for (const a of p.getAnimations()) a.cancel();
		for (const { node, parent, next } of moved.reverse()) parent.insertBefore(node, next);
		for (const n of made) n.remove();
		for (const n of [...world.children, ...sets.children]) n.remove();
		for (const s of STOPS) {
			s.sec.classList.remove("is-on", "is-tall", "has-more");
			s.sec.scrollTop = 0;
			for (const wrap of s.sec.querySelectorAll<HTMLElement>(".table-wrap")) {
				delete wrap.dataset.more;
				wrap.scrollLeft = 0;
			}
		}
		for (const p of plates) p.node.style.transform = "";
		for (const c of clouds) c.node.style.transform = "";
		page.classList.remove("is-staged");
		delete page.dataset.mode;
		delete page.dataset.travel;
		route.hidden = true;
		help.hidden = true;
		pauseBtn.hidden = true;
		stage.appendChild(toast);
		toast.classList.remove("is-shown");
		toast.innerHTML = "";
		said.textContent = "";
		if (stamps) stamps.hidden = true;
		bo.classList.remove("is-idle", "is-left", "is-landing", "is-hopping");
		bo.style.removeProperty("--bo-x");
		nextBtn.classList.add("is-nudging");
	}
	return () => {
		teardown();
		rebuilt?.();
	};
}
