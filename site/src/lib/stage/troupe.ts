// ==========================================================================
// The troupe: what happens when nobody is scrolling.
//
// A still page should not be a dead one. Once the reader has stopped for a
// few seconds a hobit turns up — one at a time, never in the text — does one
// small thing, and leaves. The moment the page moves again whoever is out
// gets out of the way, fast.
//
// Where they are allowed, and why (site/DESIGN.md, "Motion"):
//
//   on the trail    The band is the page's margin by construction.
//   behind a box    Rising from behind a card's top edge, into the gap
//                   above it. Before every appearance the gap is checked for
//                   real: if anything a reader could be looking at is there,
//                   that box is skipped.
//
// Nothing here loops and nothing here carries information. With the trail
// paused, or under prefers-reduced-motion, none of it runs at all.
// ==========================================================================

import { CAST, POSE, type Member } from "./cast";
import { isStill, onMotionChange } from "./motion";
import { Actor, Sprite } from "./sprite";
import type { Trail } from "./trail";

/** How long the page must be still before the first visitor, then between. */
const FIRST_MS = 3800;
const GAP_MS: readonly [number, number] = [8500, 16000];
/** After this many in one sitting they leave the reader alone. */
const PER_REST = 6;

const BOING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DROP = "cubic-bezier(0.5, 0, 0.9, 0.4)";

const between = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const pick = <T,>(items: readonly T[]): T | undefined =>
	items[Math.floor(Math.random() * items.length)];

/**
 * A gag's clock. Every pause in a gag goes through `wait`, so cutting the cue
 * ends all of them at once and the gag falls through to its exit.
 */
class Cue {
	cut = false;
	private wake: Array<() => void> = [];

	wait(ms: number): Promise<void> {
		if (this.cut) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = window.setTimeout(resolve, ms);
			this.wake.push(() => {
				window.clearTimeout(timer);
				resolve();
			});
		});
	}

	end(): void {
		this.cut = true;
		for (const wake of this.wake.splice(0)) wake();
	}
}

/** Slide an element and resolve when it has arrived. */
async function slide(el: HTMLElement, from: number, to: number, ms: number, easing: string) {
	const anim = el.animate(
		[{ translate: `0 ${from}px` }, { translate: `0 ${to}px` }],
		{ duration: ms, easing, fill: "forwards" },
	);
	await anim.finished.catch(() => undefined);
}

// ------------------------------------------------------------------ boxes

const HOSTS = ".terminal, .card, .postcard, .table-wrap";
/** What may sit behind a visitor: page structure, never page content. */
const BACKDROP = "main, section, .container, .grid, .hero, .cta-band, body, html";
/** Text blocks: only their actual lines are in the way, not their whole box. */
const PROSE = "p, h1, h2, h3, h4, span, strong, em, a, code, br";

type Perch = { host: HTMLElement; x: number; top: number };
type Box = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box): boolean =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Is this patch of page empty of anything a reader could be looking at?
 *
 * A paragraph's box runs the full width of its column even where its last
 * line stops halfway, so asking "what element is here" overstates what is in
 * the way. Structure is always fine; a box with its own surface never is; a
 * text block is in the way only where one of its lines actually is.
 */
function isClear(area: Box): boolean {
	const xs = [area.left + 2, (area.left + area.right) / 2, area.right - 2];
	const ys = [area.top + 2, (area.top + area.bottom) / 2, area.bottom - 3];
	const seen = new Set<Element>();
	for (const x of xs) {
		for (const y of ys) {
			const under = document.elementFromPoint(x, y);
			if (!under) return false;
			if (under.matches(BACKDROP) || seen.has(under)) continue;
			seen.add(under);
			if (!under.matches(PROSE)) return false;
			const range = document.createRange();
			range.selectNodeContents(under.closest("p, h1, h2, h3, h4") ?? under);
			const pad = 8;
			for (const line of range.getClientRects()) {
				const grown = {
					left: line.left - pad,
					top: line.top - pad,
					right: line.right + pad,
					bottom: line.bottom + pad,
				};
				if (overlaps(area, grown)) return false;
			}
		}
	}
	return true;
}

/** A spot on some box's top edge with nothing above it worth reading. */
function findPerch(width: number, rise: number, avoid: HTMLElement | null): Perch | null {
	const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
	const dock = document.querySelector(".trail-dock")?.getBoundingClientRect().top ?? innerHeight;
	const hosts = [...document.querySelectorAll<HTMLElement>(`.ink-world :is(${HOSTS})`)].filter(
		(host) => host !== avoid,
	);
	// Shuffled, so the same box is not always the first one that qualifies.
	hosts.sort(() => Math.random() - 0.5);

	for (const host of hosts) {
		const box = host.getBoundingClientRect();
		if (box.top - rise < header + 6 || box.top > dock - 18) continue;
		const inset = 36 + width / 2; // clear of the rounded corners
		if (box.width < inset * 2 + 8) continue;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const x = between(box.left + inset, box.right - inset);
			const area = {
				left: x - width * 0.44,
				right: x + width * 0.44,
				top: box.top - rise,
				bottom: box.top,
			};
			if (isClear(area)) return { host, x, top: box.top };
		}
	}
	return null;
}

type Bit = "peek" | "wave" | "nap";

/** Up from behind a box, one small bit of business, and back down. */
async function popUp(who: Member, perch: Perch, bit: Bit, cue: Cue) {
	const { sheet } = who;
	const tall = Math.round(between(58, 70) * who.stature);
	const sprite = new Sprite(sheet);
	sprite.size(tall);
	const frameH = tall / sheet.body;
	const frameW = (frameH * sheet.frameW) / sheet.frameH;

	// The clip is the box's top edge: the sprite is only ever seen above it,
	// which is all "behind the card" needs to mean.
	const clip = document.createElement("span");
	clip.className = "troupe-clip";
	clip.setAttribute("aria-hidden", "true");
	clip.style.left = `${perch.x - frameW / 2 + scrollX}px`;
	clip.style.top = `${perch.top - frameH + scrollY}px`;
	clip.style.width = `${frameW}px`;
	clip.style.height = `${frameH}px`;
	const s = sprite.el.style;
	s.left = "0";
	s.top = "0";
	clip.append(sprite.el);
	document.body.append(clip);

	const hidden = frameH;
	const shown =
		bit === "peek"
			? frameH * (1 - who.peek)
			: bit === "wave"
				? frameH * (1 - sheet.feet + 0.16)
				: frameH * (1 - sheet.feet);

	let poked = false;
	sprite.el.addEventListener("pointerdown", () => {
		poked = true;
		cue.end();
	});

	await slide(sprite.el, hidden, shown, 420, BOING);

	if (bit === "peek") {
		await cue.wait(520);
		for (const look of [POSE.lookLeft, POSE.lookRight]) {
			if (cue.cut) break;
			sprite.frame(look);
			await cue.wait(between(520, 760));
		}
		if (!cue.cut) {
			sprite.frame(POSE.stand);
			await cue.wait(260);
			sprite.frame(POSE.blink);
			await cue.wait(130);
			sprite.frame(POSE.stand);
			await cue.wait(420);
		}
	} else if (bit === "wave") {
		await cue.wait(260);
		for (let i = 0; i < 3 && !cue.cut; i += 1) {
			sprite.frame(POSE.wave);
			await cue.wait(230);
			sprite.frame(POSE.stand);
			await cue.wait(170);
		}
		await cue.wait(360);
	} else {
		await cue.wait(700);
		if (!cue.cut) {
			sprite.frame(POSE.blink);
			await cue.wait(260);
			sprite.frame(POSE.doze);
			sprite.el.classList.add("is-dozing");
			await cue.wait(between(9000, 14000));
			sprite.el.classList.remove("is-dozing");
		}
	}

	// Caught out — by the page moving, or by being poked — he startles first.
	// Left alone, a napper just wakes up.
	if (cue.cut) {
		sprite.frame(POSE.startled);
		await new Promise((r) => window.setTimeout(r, poked ? 190 : 110));
	} else if (bit === "nap") {
		sprite.frame(POSE.blink);
		await cue.wait(240);
		sprite.frame(POSE.stand);
		await cue.wait(380);
	}
	await slide(sprite.el, shown, hidden, cue.cut ? 150 : 230, cue.cut ? DROP : EASE);
	sprite.stop();
	clip.remove();
}

// ------------------------------------------------------------------ trail

/** One frame of travel for someone crossing the band under their own power. */
function travel(update: (dt: number) => boolean): Promise<void> {
	return new Promise((resolve) => {
		let last = performance.now();
		const step = (now: number) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			if (update(dt)) requestAnimationFrame(step);
			else resolve();
		};
		requestAnimationFrame(step);
	});
}

function enter(who: Member, trail: Trail) {
	const { sheet } = who;
	const unit = trail.unit();
	// A little smaller than Bo and a little further back, so he reads as
	// someone else on the same road rather than a second Bo.
	const tall = 121 * unit * 0.8 * who.stature;
	const sprite = new Sprite(sheet);
	sprite.size(tall);
	const actor = new Actor(sprite, "troupe-traveler");
	const half = (tall / sheet.body) * (sheet.frameW / sheet.frameH) * 0.5;
	const ground = trail.bo().feet - 8 * unit;
	trail.actors.append(actor.el);
	actor.place(-half, ground);
	return { sprite, actor, tall, half, ground };
}

const WALK: readonly number[] = [POSE.walkA, POSE.walkPass, POSE.walkB, POSE.walkPass];

/** Flat out to the right-hand edge. Feet are a blur, so nothing can skate. */
async function dash(
	who: ReturnType<typeof enter>,
	trail: Trail,
	pxPerSecond: number,
): Promise<void> {
	const { sprite, actor, half, ground } = who;
	actor.el.classList.add("is-dashing");
	let beat = 0;
	await travel((dt) => {
		beat += dt;
		sprite.frame(Math.floor(beat / 0.07) % 2 === 0 ? POSE.run : POSE.runB);
		actor.place(actor.x + pxPerSecond * dt, ground);
		return actor.x < trail.width() + half;
	});
}

/**
 * Someone catches Bo up, keeps him company while the page is still, and bolts
 * when it moves.
 */
async function company(who: Member, trail: Trail, cue: Cue) {
	const cast = enter(who, trail);
	const { sprite, actor, tall, ground } = cast;
	const stand = trail.bo().x + tall * 1.25;
	const pace = tall * who.stride;

	// He rides the ground like everything else standing on it, and the ground
	// moving is also his cue to go.
	const off = trail.onGround((dx) => {
		actor.place(actor.x + dx, ground);
		cue.end();
	});

	// Walk in: each pose covers one pace, so the feet do not slide.
	let i = 0;
	while (!cue.cut && actor.x < stand) {
		sprite.frame(WALK[i % WALK.length] ?? POSE.stand);
		actor.el.classList.toggle("is-up", i % 2 === 1);
		actor.place(actor.x + pace, ground);
		i += 1;
		await cue.wait(105);
	}
	actor.el.classList.remove("is-up");

	if (!cue.cut) {
		sprite.frame(POSE.stand);
		trail.greet();
		await cue.wait(420);
		for (let n = 0; n < 2 && !cue.cut; n += 1) {
			sprite.frame(POSE.wave);
			await cue.wait(240);
			sprite.frame(POSE.stand);
			await cue.wait(180);
		}
		// Standing about, the way Bo does.
		const until = performance.now() + between(9000, 15000);
		while (!cue.cut && performance.now() < until) {
			await cue.wait(between(1800, 4200));
			if (cue.cut) break;
			sprite.frame(pick([POSE.blink, POSE.blink, POSE.lookLeft, POSE.lookRight]) ?? POSE.blink);
			await cue.wait(190);
			sprite.frame(POSE.stand);
		}
	}

	off();
	if (cue.cut) {
		sprite.frame(POSE.startled);
		await new Promise((r) => window.setTimeout(r, 130));
	}
	await dash(cast, trail, cue.cut ? 620 : 430);
	actor.remove();
}

/** The express: someone with somewhere to be goes straight through. */
async function express(who: Member, trail: Trail) {
	const cast = enter(who, trail);
	await dash(cast, trail, 470);
	cast.actor.remove();
}

// --------------------------------------------------------------- director

export function mountTroupe(trail: Trail): void {
	if (CAST.length === 0) return;

	let stillSince = performance.now();
	let nextAfter = FIRST_MS;
	let shown = 0;
	let cue: Cue | null = null;
	let lastWho: Member | null = null;
	let lastHost: HTMLElement | null = null;

	const stir = () => {
		stillSince = performance.now();
		shown = 0;
		nextAfter = FIRST_MS;
		cue?.end();
	};
	window.addEventListener("scroll", stir, { passive: true });
	window.addEventListener("keydown", stir);
	onMotionChange(() => cue?.end());
	document.addEventListener("visibilitychange", () => cue?.end());

	const send = async () => {
		const who = pick(CAST.filter((m) => m !== lastWho || CAST.length === 1));
		if (!who) return;
		lastWho = who;
		const mine = new Cue();
		cue = mine;

		const onTrail = trail.width() > 0 && Math.random() < 0.38;
		if (onTrail) {
			if (Math.random() < 0.3) await express(who, trail);
			else await company(who, trail, mine);
		} else {
			const bit =
				pick<Bit>(shown > 1 ? ["peek", "peek", "wave", "nap"] : ["peek", "peek", "wave"]) ?? "peek";
			const { sheet } = who;
			const frameH = (70 * who.stature) / sheet.body;
			// The figure is narrower than its cell, and only as much of him as
			// the bit shows ever rises above the edge.
			const wide = frameH * (sheet.frameW / sheet.frameH) * 0.62;
			// A cell is mostly air above the head: what rises above the edge is
			// the figure, measured from the top of his tufts.
			const crown = sheet.feet - sheet.body;
			const peekRise = frameH * (who.peek - crown);
			const rise = bit === "peek" ? peekRise : frameH * (sheet.body + 0.04);
			// A full-height bit needs more room than there usually is; a peek
			// is the fallback before giving the turn to the trail.
			const perch =
				findPerch(wide, rise, lastHost) ??
				(bit === "peek" ? null : findPerch(wide, peekRise, lastHost));
			if (perch) {
				lastHost = perch.host;
				const fits = isClear({
					left: perch.x - wide * 0.44,
					right: perch.x + wide * 0.44,
					top: perch.top - rise,
					bottom: perch.top,
				});
				await popUp(who, perch, fits ? bit : "peek", mine);
			} else if (trail.width() > 0) {
				await company(who, trail, mine);
			}
		}

		if (cue === mine) cue = null;
		shown += 1;
		stillSince = performance.now();
		nextAfter = between(...GAP_MS);
	};

	window.setInterval(() => {
		if (cue || shown >= PER_REST || isStill()) return;
		if (document.visibilityState !== "visible") return;
		// Another design's world has its own art; the troupe belongs to this one.
		if (document.documentElement.dataset.design) return;
		if (performance.now() - stillSince < nextAfter) return;
		void send();
	}, 450);
}
