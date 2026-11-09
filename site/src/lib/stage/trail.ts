// ==========================================================================
// The trail, driven by the page.
//
// Without this file the band still works: CSS walks Bo along a looping trail
// on a timer (see ParallaxTrail.astro). This takes the wheel from that timer
// and hands it to the scrollbar, so that reading down the page *is* walking
// down the trail:
//
//   - the ground travels a fixed fraction of however far the page scrolled,
//     and every other layer a fraction of that — the same slot speeds the
//     plates always declared, now multiplying distance instead of time;
//   - Bo's stride is taken from the ground actually covered, so his planted
//     foot stays planted. Scroll back up and the reel runs backwards: same
//     frames, reverse order, feet still planted. He is never mirrored;
//   - each section's landmarks ride the ground and pull alongside him as that
//     section's heading reaches the reading line;
//   - when the page stops, he stops, and stands about until it moves again.
//
// The world follows the scroll position rather than tracking it exactly. A
// wheel notch lands in a few milliseconds and would arrive as a jump cut;
// easing toward it turns the same distance into a short walk that always
// ends in a slow last step, which is where a planted foot can be seen.
// ==========================================================================

import { isPaused, isStill, onMotionChange, restoreMotion, setPaused } from "./motion";

/** Pixels of ground per pixel of page. Under 1, as site/DESIGN.md requires. */
const GROUND_PER_SCROLL = 0.5;
/** Seconds for the world to close ~63% of the gap to the scroll position. */
const FOLLOW = 0.14;
/** Bo's planted foot tracks back 11px of a 554px frame, per frame. */
const STRIDE = 11 / 554;
const WALK_FRAMES = 36;
const WALK_COLS = 6;
/** Walk frames per second before legs are simply a blur; his own pace is 20. */
const GAIT_CAP = 46;
/** A section has "arrived" when its top crosses this far down the viewport. */
const READING_LINE = 0.42;
/** How long the ground has to be still before he stops walking on the spot. */
const SETTLE_MS = 140;

const mod = (n: number, m: number): number => ((n % m) + m) % m;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

type LayerRef = { el: HTMLElement; speed: number; units: number; tile: number };
type MarkRef = {
	el: HTMLElement;
	stop: string;
	atUnits: number;
	at: number;
	speed: number;
	width: number;
	shown: boolean;
};
type StopRef = { key: string; label: string; el: HTMLElement; scroll: number };

export type Trail = {
	readonly band: HTMLElement;
	/** Where travelers stand: a layer between the path and Bo. */
	readonly actors: HTMLElement;
	/** One tile unit, in CSS pixels. */
	unit(): number;
	width(): number;
	/** Bo's centre and the row his feet land on, in band pixels. */
	bo(): { x: number; feet: number };
	/**
	 * Called with how far the ground moved on screen this frame, in pixels.
	 * Returns the way to stop listening.
	 */
	onGround(listener: (dx: number) => void): () => void;
	/** Bo acknowledges company with one hop, if he is standing still. */
	greet(): void;
};

function need<T extends Element>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`trail: ${selector} is missing from the band`);
	return el;
}

export function mountTrail(band: HTMLElement): Trail {
	restoreMotion();

	const scene = need<HTMLElement>(band, ".plx-scene");
	const actors = need<HTMLElement>(band, ".plx-actors");
	const bo = need<HTMLElement>(band, ".plx-bo");
	const walk = need<HTMLElement>(band, ".plx-bo-walk");
	const idle = need<HTMLElement>(band, ".plx-bo-idle");
	const where = need<HTMLElement>(band, ".plx-where");
	const pause = need<HTMLButtonElement>(band, ".plx-pause");

	const layers: LayerRef[] = [...band.querySelectorAll<HTMLElement>("[data-plx-speed]")].map(
		(el) => ({
			el,
			speed: Number(el.dataset.plxSpeed),
			units: Number(el.dataset.plxTile),
			tile: 0,
		}),
	);
	const marks: MarkRef[] = [...band.querySelectorAll<HTMLElement>("[data-plx-stop]")].map((el) => ({
		el,
		stop: el.dataset.plxStop ?? "",
		atUnits: Number(el.dataset.plxAt),
		at: 0,
		speed: Number(el.dataset.plxMarkSpeed),
		width: 0,
		shown: false,
	}));
	const stops: StopRef[] = [...document.querySelectorAll<HTMLElement>("[data-trail-stop]")].map(
		(el) => ({
			key: el.dataset.trailStop ?? "",
			label: el.dataset.trailLabel ?? "",
			el,
			scroll: 0,
		}),
	);

	let unit = 1;
	let width = 0;
	let boX = 0;
	let boFeet = 0;
	let stride = 1;

	let world = 0;
	let phase = 0;
	let lean = 0;
	let raf = 0;
	let last = 0;
	let lastMove = 0;
	let resting = true;
	let here = "";
	const listeners: Array<(dx: number) => void> = [];

	// ---------------------------------------------------------------- layout

	const measure = () => {
		const box = scene.getBoundingClientRect();
		if (box.width === 0) return false; // another world is showing; band is hidden
		unit = box.height / 300;
		width = box.width;
		const boBox = bo.getBoundingClientRect();
		boX = boBox.left - box.left + boBox.width * 0.53;
		boFeet = boBox.top - box.top + boBox.height * (524 / 542);
		stride = STRIDE * boBox.width;
		for (const layer of layers) layer.tile = layer.units * unit;
		for (const mark of marks) {
			mark.at = mark.atUnits * unit;
			mark.width = mark.el.offsetWidth;
		}
		const line = window.innerHeight * READING_LINE;
		const max = document.documentElement.scrollHeight - window.innerHeight;
		for (const stop of stops) {
			const top = stop.el.getBoundingClientRect().top + window.scrollY;
			stop.scroll = clamp(top - line, 0, Math.max(0, max));
		}
		return true;
	};

	const stopFor = (scroll: number): StopRef | undefined => {
		let found = stops[0];
		for (const stop of stops) if (stop.scroll <= scroll + 1) found = stop;
		return found;
	};

	// ----------------------------------------------------------------- drawing

	const setFrame = (index: number) => {
		const col = index % WALK_COLS;
		const row = Math.floor(index / WALK_COLS);
		walk.style.backgroundPosition = `${(col / (WALK_COLS - 1)) * 100}% ${(row / (WALK_COLS - 1)) * 100}%`;
	};

	const placeMarks = (ground: number, only?: string) => {
		for (const mark of marks) {
			const stop = stops.find((s) => s.key === mark.stop);
			if (!stop) continue;
			const centre = boX + mark.at + (stop.scroll * GROUND_PER_SCROLL - ground) * mark.speed;
			const left = centre - mark.width / 2;
			const shown =
				only === undefined
					? left < width + 60 && left + mark.width > -60
					: mark.stop === only;
			if (shown) mark.el.style.transform = `translate3d(${left.toFixed(1)}px, 0, 0)`;
			if (shown !== mark.shown) {
				mark.shown = shown;
				mark.el.classList.toggle("is-on", shown);
			}
		}
	};

	const announce = (scroll: number) => {
		const stop = stopFor(scroll);
		if (!stop || stop.key === here) return;
		here = stop.key;
		band.dataset.plxHere = here;
		where.textContent = stop.label;
		// Retrigger the little card-flip; reading offsetWidth is what restarts it.
		where.classList.remove("is-flip");
		void where.offsetWidth;
		where.classList.add("is-flip");
	};

	const setResting = (on: boolean) => {
		if (resting === on) return;
		resting = on;
		bo.classList.toggle("is-walking", !on);
		if (on) {
			bo.classList.add("is-settle");
		} else {
			bo.classList.remove("is-settle", "is-blink", "is-hop");
		}
	};

	/** The band with nothing moving: every layer home, this stop's props in place. */
	const drawStill = () => {
		cancelAnimationFrame(raf);
		raf = 0;
		if (!measure()) return;
		for (const layer of layers) layer.el.style.transform = "";
		const stop = stopFor(window.scrollY);
		// Composed as if he had just arrived, without anything having travelled.
		world = (stop?.scroll ?? 0) * GROUND_PER_SCROLL;
		placeMarks(world, stop?.key);
		announce(window.scrollY);
		lean = 0;
		bo.style.setProperty("--lean", "0deg");
		setResting(true);
		bo.classList.remove("is-settle");
	};

	const tick = (now: number) => {
		raf = 0;
		const dt = clamp((now - last) / 1000, 0.001, 0.05);
		last = now;

		const target = window.scrollY * GROUND_PER_SCROLL;
		const gap = target - world;
		const step = Math.abs(gap) < 0.3 ? gap : gap * (1 - Math.exp(-dt / FOLLOW));
		world += step;

		for (const layer of layers) {
			if (layer.tile <= 0) continue;
			const shift = mod(world * layer.speed, layer.tile);
			layer.el.style.transform = `translate3d(${(-shift).toFixed(2)}px, 0, 0)`;
		}
		placeMarks(world);
		announce(window.scrollY);

		// His legs take exactly the ground that went by, up to the speed at
		// which a stride stops being readable and he is just running.
		const paces = clamp(step / stride, -GAIT_CAP * dt, GAIT_CAP * dt);
		phase = mod(phase + paces, WALK_FRAMES);
		setFrame(Math.floor(phase));

		const speed = step / dt;
		const leaning = clamp(speed / 620, -1, 1);
		lean += (leaning - lean) * (1 - Math.exp(-dt / 0.1));
		if (Math.abs(lean) < 0.004) lean = 0;
		bo.style.setProperty("--lean", `${(lean * 5).toFixed(2)}deg`);

		if (Math.abs(step) > 0.02) {
			lastMove = now;
			setResting(false);
			for (const listener of listeners) listener(-step);
		} else if (now - lastMove > SETTLE_MS) {
			setResting(true);
		}

		if (Math.abs(target - world) > 0.01 || lean !== 0 || !resting) schedule();
	};

	const schedule = () => {
		if (raf || isStill()) return;
		last = performance.now() - 16;
		raf = requestAnimationFrame(tick);
	};

	// -------------------------------------------------------------- idling

	// Blinking is ordinary; a hop is a treat. Same cadence as BoIdle, kept
	// here because this Bo also has to stop the moment the ground moves.
	const fidget = () => {
		if (resting && !isStill() && document.visibilityState === "visible") {
			play(Math.random() < 0.2 ? "is-hop" : "is-blink");
		}
		window.setTimeout(fidget, 2400 + Math.random() * 5200);
	};
	const play = (name: "is-hop" | "is-blink") => {
		if (!resting || bo.classList.contains("is-hop") || bo.classList.contains("is-blink")) return;
		bo.classList.remove("is-settle");
		bo.classList.add(name);
	};
	idle.addEventListener("animationend", () => bo.classList.remove("is-hop", "is-blink"));
	bo.addEventListener("animationend", (event) => {
		if (event.target === bo) bo.classList.remove("is-settle");
	});
	window.setTimeout(fidget, 1800 + Math.random() * 2600);

	// ------------------------------------------------------------- controls

	const syncPause = () => {
		const paused = isPaused();
		pause.setAttribute("aria-pressed", String(paused));
		band.classList.toggle("is-still", isStill());
		if (isStill()) drawStill();
		else if (measure()) schedule();
	};
	pause.addEventListener("click", () => setPaused(!isPaused()));
	onMotionChange(syncPause);

	// A landmark is the section it stands for: a click goes there. Pointer
	// only — the headings themselves are the keyboard path.
	for (const mark of marks) {
		mark.el.addEventListener("click", () => {
			const stop = stops.find((s) => s.key === mark.stop);
			stop?.el.scrollIntoView({ behavior: isStill() ? "auto" : "smooth", block: "start" });
		});
	}
	bo.addEventListener("pointerenter", () => play("is-hop"));

	window.addEventListener(
		"scroll",
		() => {
			if (isStill()) drawStill();
			else schedule();
		},
		{ passive: true },
	);

	let resize = 0;
	const relayout = () => {
		window.clearTimeout(resize);
		resize = window.setTimeout(() => {
			if (isStill()) drawStill();
			else if (measure()) schedule();
		}, 120);
	};
	window.addEventListener("resize", relayout);
	// Late fonts and images move every section, and with them every stop.
	if ("ResizeObserver" in window) new ResizeObserver(relayout).observe(document.body);
	// Switching to another design hides the band; switching back needs a fresh look.
	new MutationObserver(relayout).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-design"],
	});

	// ---------------------------------------------------------------- start

	band.classList.add("is-driven");
	if (measure()) {
		const target = window.scrollY * GROUND_PER_SCROLL;
		// He walks the last few steps into frame: the page's one arrival.
		world = isStill() ? target : target - Math.min(width * 0.16, 190);
	}
	syncPause();

	return {
		band,
		actors,
		unit: () => unit,
		width: () => width,
		bo: () => ({ x: boX, feet: boFeet }),
		onGround: (listener) => {
			listeners.push(listener);
			return () => {
				const at = listeners.indexOf(listener);
				if (at >= 0) listeners.splice(at, 1);
			};
		},
		greet: () => play("is-hop"),
	};
}
