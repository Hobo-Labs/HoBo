// ==========================================================================
// A sprite sheet, played by frame index.
//
// Frames are addressed in percentages rather than pixels: the same sheet is
// drawn at whatever size the band or the page needs, and a pixel offset at a
// fractional size is how a neighbouring frame bleeds in along one edge.
//
// A sprite is anchored by the soles of the feet, not by its box. The sheets
// vary the character's height to carry motion, so anchoring any other way
// makes him bob against the ground between frames (see
// public/cast/README.md). `Actor` is that anchor: a zero-size point you
// place, with the sprite hung off it.
// ==========================================================================

export type Sheet = {
	/** Site-relative path, without the base. */
	src: string;
	cols: number;
	rows: number;
	frameW: number;
	frameH: number;
	/** Feet line, as a fraction of the frame height from the top. */
	feet: number;
	/** Body centre, as a fraction of the frame width from the left. */
	cx: number;
	/** The standing character's height (tufts to soles) over the frame height. */
	body: number;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** A site-relative path with the deploy base in front. */
export const asset = (path: string): string => `${BASE}${path}`;

export class Sprite {
	readonly el: HTMLElement;
	private timer = 0;
	private current = -1;

	constructor(readonly sheet: Sheet) {
		const el = document.createElement("span");
		el.className = "sprite";
		el.style.backgroundImage = `url("${asset(sheet.src)}")`;
		el.style.backgroundSize = `${sheet.cols * 100}% ${sheet.rows * 100}%`;
		this.el = el;
		this.frame(0);
	}

	/** Size the sprite so the standing character is `px` tall. */
	size(px: number): void {
		const { sheet } = this;
		const h = px / sheet.body;
		const w = (h * sheet.frameW) / sheet.frameH;
		const s = this.el.style;
		s.width = `${w}px`;
		s.height = `${h}px`;
		s.left = `${-sheet.cx * w}px`;
		s.top = `${-sheet.feet * h}px`;
	}

	frame(index: number): void {
		if (index === this.current) return;
		this.current = index;
		const { cols, rows } = this.sheet;
		const col = index % cols;
		const row = Math.floor(index / cols);
		const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
		const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
		this.el.style.backgroundPosition = `${x}% ${y}%`;
	}

	/**
	 * Step through `frames`, one every `ms`. Resolves when a one-shot ends;
	 * a loop runs until `stop()` and resolves then.
	 */
	play(frames: readonly number[], ms: number, loop = false): Promise<void> {
		this.stop();
		return new Promise((resolve) => {
			let i = 0;
			const step = () => {
				const next = frames[i];
				if (next === undefined) return;
				this.frame(next);
				i += 1;
				if (i >= frames.length) {
					if (!loop) {
						this.timer = window.setTimeout(resolve, ms);
						return;
					}
					i = 0;
				}
				this.timer = window.setTimeout(step, ms);
			};
			this.halt = resolve;
			step();
		});
	}

	private halt: (() => void) | null = null;

	stop(): void {
		window.clearTimeout(this.timer);
		this.timer = 0;
		const done = this.halt;
		this.halt = null;
		done?.();
	}
}

/** A point on the stage with a sprite standing on it. */
export class Actor {
	readonly el: HTMLElement;
	x = 0;
	y = 0;

	constructor(
		readonly sprite: Sprite,
		className = "",
	) {
		const el = document.createElement("span");
		el.className = `actor ${className}`.trim();
		el.setAttribute("aria-hidden", "true");
		el.append(sprite.el);
		this.el = el;
	}

	place(x: number, y: number): void {
		this.x = x;
		this.y = y;
		this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
	}

	remove(): void {
		this.sprite.stop();
		this.el.remove();
	}
}
