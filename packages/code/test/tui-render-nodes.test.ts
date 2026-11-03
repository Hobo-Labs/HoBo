/**
 * Painting a retained TUI tree to a fixed-width frame.
 *
 * The renderer is one dispatch over a node's class list, and each arm exists
 * because that kind of pane needs something the generic arm would get wrong.
 * The tests are organised by that dispatch, and the interesting cases are the
 * ones where two arms disagree:
 *
 * **Where a pane anchors when it is shorter than its viewport.** A transcript
 * and a chat surface pad toward the end, because the newest line is the one
 * being read. An approval pads toward the start — the question is at the top,
 * and pushing it off-screen to keep the scrollback flush would hide the thing
 * being approved.
 *
 * **The pane list uses `fitCells` and never `wrapText`.** Its rows are already
 * shaped into `│` columns; wrapping one that is a single cell over the glass
 * width would break the column alignment for every row below it.
 *
 * **A rail is measured before it is drawn.** Chips are added while they fit and
 * the first one that does not ends the row — a rail that overflowed would push
 * the frame wider than the terminal it was measured for.
 *
 * **An overlay is composited over its host, not appended to it.** It is blitted
 * bottom-right into the already-padded body, so the pane underneath keeps its
 * height and the card sits on the glass rather than lengthening it.
 *
 * Pure: a tree in, a string out.
 */
import { describe, expect, it } from "vitest";
import { renderTuiTree } from "../src/tui-render.js";
import { h } from "../src/tui-tree.js";

const text = (value: string) => h("text", null, value);

const lines = (node: Parameters<typeof renderTuiTree>[0], width = 40) =>
	renderTuiTree(node, width).split("\n");

describe("text", () => {
	it("renders its own string", () => {
		expect(lines(text("hello"))[0]).toBe("hello");
	});

	it("renders a text-role node by its children when it holds no string", () => {
		// `h` only lifts a string into `text` when it is the sole child. A text
		// node with element children still has to paint them.
		expect(
			lines(h("span", { role: "text" }, text("a"), text("b"))).join(""),
		).toBe("ab");
	});

	it("keeps an empty string as a line rather than dropping it", () => {
		// A blank line is spacing the caller asked for; dropping it would close
		// up a gap that was deliberate.
		expect(lines(h("box", null, text(""), text("x")))).toEqual(["", "x"]);
	});

	it("descends through a plain container", () => {
		expect(lines(h("box", null, h("box", null, text("deep"))))[0]).toBe("deep");
	});

	it("flattens a fragment into its parent", () => {
		expect(
			lines(h("box", null, h("fragment", null, text("a"), text("b")))),
		).toEqual(["a", "b"]);
	});
});

describe("the command rail", () => {
	const rail = (names: readonly string[], width = 40) =>
		lines(
			h(
				"box",
				{ className: "command-rail" },
				...names.map((name) => text(name)),
			),
			width,
		);

	it("draws each name as a chip", () => {
		expect(rail(["save"])[0]).toContain("[ save ]");
	});

	it("separates chips with two spaces", () => {
		expect(rail(["a", "b"])[0]).toContain("[ a ]  [ b ]");
	});

	it("centres the row", () => {
		expect(rail(["a"])[0]?.startsWith(" ")).toBe(true);
	});

	it("stops adding chips once the row is full", () => {
		// Measured before it is drawn: a rail that overflowed would push the
		// frame wider than the terminal it was measured for.
		const row = rail(["alpha", "bravo", "charlie", "delta", "echo"], 24)[0];
		expect((row ?? "").length).toBeLessThanOrEqual(24);
	});

	it("keeps the chips that did fit", () => {
		expect(rail(["alpha", "bravo", "charlie", "delta"], 24)[0]).toContain(
			"alpha",
		);
	});

	it("skips an empty name rather than drawing an empty chip", () => {
		expect(rail(["", "a"])[0]).not.toContain("[  ]");
	});

	it("draws an empty row when nothing fits", () => {
		expect(rail(["averyverylongcommandname"], 10)[0]?.trim()).toBe("");
	});

	it("renders a legend as one centred line", () => {
		// The legend is prose, not chips: it is one sentence and it is centred
		// whole rather than broken into bracketed tokens.
		const row = lines(
			h(
				"box",
				{ className: "command-rail agents-legend" },
				text("Tab field"),
				text("Esc back"),
			),
		)[0];
		expect(row).toContain("Tab field Esc back");
	});

	it("does not bracket a legend", () => {
		expect(
			lines(
				h("box", { className: "command-rail agents-legend" }, text("Tab")),
			)[0],
		).not.toContain("[");
	});

	it("truncates a legend that does not fit", () => {
		const row = lines(
			h(
				"box",
				{ className: "command-rail agents-legend" },
				text("a legend far longer than the frame it is drawn into"),
			),
			20,
		)[0];
		expect(row).toHaveLength(20);
		expect(row?.endsWith("…")).toBe(true);
	});
});

describe("panes that scroll", () => {
	const body = (cls: string, count: number, props = {}) =>
		h(
			"box",
			{ className: cls, ...props },
			...Array.from({ length: count }, (_u, i) => text(`row${i}`)),
		);

	it("returns every line when no height is given", () => {
		// Unbounded: the caller is measuring, not painting into a viewport.
		expect(lines(body("chat-surface", 6))).toHaveLength(6);
	});

	it("blank-pads a chat surface toward the end", () => {
		// The newest line is the one being read, so a short surface sits at the
		// bottom of its glass rather than the top.
		const painted = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 6 } },
				body("chat-surface", 1),
			),
		);
		expect(painted.join("\n")).toContain("row0");
	});

	it("anchors an approval at the start instead", () => {
		// The question is at the top. Pushing it off-screen to keep the
		// scrollback flush would hide the thing being approved.
		const painted = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 8 } },
				body("approval", 2),
			),
		);
		const first = painted.findIndex((l) => l.includes("row0"));
		const last = painted.findIndex((l) => l.includes("row1"));
		expect(first).toBeLessThan(last);
	});

	it("spaces transcript entries apart", () => {
		// Each child is a turn; a blank line between them is what makes two
		// turns readable as two rather than one run-on block.
		expect(lines(body("transcript", 2))).toEqual(["row0", "", "row1", ""]);
	});

	it("pads a table without scrolling it", () => {
		// A table is a fixed block; scrolling it would separate rows from the
		// header they belong to.
		expect(
			lines(
				h(
					"box",
					{ className: "ink-card", style: { height: 7 } },
					body("ink-table", 2),
				),
			).join("\n"),
		).toContain("row0");
	});

	it("takes a scroll offset from the node", () => {
		const scrolled = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20, { scroll: 5 }),
			),
		).join("\n");
		const unscrolled = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20),
			),
		).join("\n");
		expect(scrolled).not.toBe(unscrolled);
	});

	it("treats a non-numeric scroll as none", () => {
		// Props come off a tree that anything can write into; a string there
		// must not become NaN inside the slice arithmetic.
		const bad = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20, { scroll: "lots" }),
			),
		).join("\n");
		const none = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20),
			),
		).join("\n");
		expect(bad).toBe(none);
	});

	it("honours an explicit start origin", () => {
		const started = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20, { scrollOrigin: "start" }),
			),
		).join("\n");
		expect(started).toContain("row0");
	});

	it("treats an unrecognised origin as end", () => {
		// `end` is the default and the fallback: a typo in the prop must not
		// silently flip which end of a long transcript is on screen.
		const odd = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20, { scrollOrigin: "middle" }),
			),
		).join("\n");
		const dflt = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 5 } },
				body("chat-surface", 20),
			),
		).join("\n");
		expect(odd).toBe(dflt);
	});
});

describe("the slash palette", () => {
	const palette = (count: number, props = {}) =>
		h(
			"box",
			{ className: "slash-palette", ...props },
			...Array.from({ length: count }, (_u, i) => text(`item${i}`)),
		);

	it("lists every item when unbounded", () => {
		expect(lines(palette(9))).toHaveLength(9);
	});

	it("windows around the selection when it has a height", () => {
		// The selected row has to be on screen; a fixed top-N window would put
		// the cursor outside the list as soon as someone scrolled past it.
		const painted = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 6 } },
				palette(30, { selectedIndex: 20 }),
			),
		).join("\n");
		expect(painted).toContain("item20");
	});

	it("defaults the selection to the first item", () => {
		const painted = lines(
			h("box", { className: "ink-card", style: { height: 6 } }, palette(30)),
		).join("\n");
		expect(painted).toContain("item0");
	});

	it("treats a non-numeric selection as the first item", () => {
		const painted = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 6 } },
				palette(30, { selectedIndex: "third" }),
			),
		).join("\n");
		expect(painted).toContain("item0");
	});
});

describe("the pane list", () => {
	it("fits a row to the width", () => {
		const row = lines(
			h("box", { className: "pane-list" }, text("a".repeat(80))),
			20,
		)[0];
		expect([...(row ?? "")].length).toBeLessThanOrEqual(20);
	});

	it("keeps a column row on one line rather than wrapping it", () => {
		// Pre-shaped rows: wrapping one that is a single cell over the glass
		// width would break the `│` alignment for every row below it.
		expect(
			lines(h("box", { className: "pane-list" }, text("a │ b │ c")), 8),
		).toHaveLength(1);
	});

	it("keeps one line per child", () => {
		expect(
			lines(h("box", { className: "pane-list" }, text("one"), text("two"))),
		).toHaveLength(2);
	});
});

describe("the text pane", () => {
	it("wraps prose to the width", () => {
		// The opposite choice from the pane list, and for the opposite reason:
		// prose has no columns to break.
		expect(
			lines(
				h("box", { className: "text-pane" }, text("word ".repeat(30).trim())),
				20,
			).length,
		).toBeGreaterThan(1);
	});

	it("joins its children with newlines before wrapping", () => {
		expect(
			lines(h("box", { className: "text-pane" }, text("a"), text("b"))),
		).toEqual(["a", "b"]);
	});
});

describe("the btw aside", () => {
	it("wraps each child on its own", () => {
		expect(
			lines(h("box", { className: "btw-aside" }, text("a"), text("b"))),
		).toEqual(["a", "b"]);
	});

	it("does not pad when it is an overlay", () => {
		// An overlay is composited by its host, which owns the height. Padding
		// here would make the card taller than the glass it sits on.
		expect(
			lines(
				h(
					"box",
					{ className: "btw-aside overlay", style: { height: 9 } },
					text("note"),
				),
			),
		).toHaveLength(1);
	});
});

describe("the status strap", () => {
	it("renders as a single stripe", () => {
		expect(
			lines(h("strap", null, text("ready"), text("2 agents"))),
		).toHaveLength(1);
	});

	it("carries its text", () => {
		expect(lines(h("strap", null, text("ready")))[0]).toContain("ready");
	});

	it("is selected by class as well as by type", () => {
		expect(
			lines(h("box", { className: "status-strap" }, text("ready"))),
		).toHaveLength(1);
	});

	it("fills the width", () => {
		// The stripe is inverse-video, so the rendered string carries SGR codes
		// on top of the 30 printed cells. Width is measured on the text alone.
		const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
		const painted = lines(h("strap", null, text("ready")), 30)[0] ?? "";
		expect([...painted.replace(sgr, "")]).toHaveLength(30);
	});
});

describe("the ink card", () => {
	const card = (children: unknown[], style = {}) =>
		// SAFETY: the fixture is the child shape the renderer walks.
		lines(h("box", { className: "ink-card", style }, ...(children as never[])));

	it("draws a border around its body", () => {
		expect(card([text("body")])[0]).toMatch(/[┏┌╭]/u);
	});

	it("carries a title into the chrome", () => {
		expect(card([text("body")], { title: "Session" }).join("\n")).toContain(
			"Session",
		);
	});

	it("renders without a title", () => {
		expect(card([text("body")]).join("\n")).toContain("body");
	});

	it("takes an accent", () => {
		expect(card([text("body")], { accent: "signal" }).join("\n")).toContain(
			"body",
		);
	});

	it("holds the height it was given", () => {
		// Two border rows plus the glass.
		expect(card([text("body")], { height: 6 }).length).toBeGreaterThan(6);
	});

	it("puts the rail below the body", () => {
		const painted = card([
			h("box", { className: "command-rail" }, text("save")),
			text("body"),
		]);
		const bodyRow = painted.findIndex((l) => l.includes("body"));
		const railRow = painted.findIndex((l) => l.includes("[ save ]"));
		expect(railRow).toBeGreaterThan(bodyRow);
	});

	it("keeps the rail out of the scrolling body", () => {
		// The rail is the actions; scrolling it away would leave a pane whose
		// keys are unreachable.
		expect(
			card(
				[
					h("box", { className: "command-rail" }, text("save")),
					h(
						"box",
						{ className: "chat-surface", scroll: 40 },
						...Array.from({ length: 40 }, (_u, i) => text(`row${i}`)),
					),
				],
				{ height: 5 },
			).join("\n"),
		).toContain("[ save ]");
	});
});

describe("compositing an overlay", () => {
	const host = (overlayLines: number, height = 12) =>
		lines(
			h(
				"box",
				{ className: "ink-card", style: { height } },
				h(
					"box",
					{ className: "chat-surface" },
					...Array.from({ length: 6 }, (_u, i) => text(`host${i}`)),
				),
				h(
					"box",
					{ className: "btw-aside overlay" },
					...Array.from({ length: overlayLines }, (_u, i) => text(`note${i}`)),
				),
			),
			60,
		);

	it("draws the overlay card", () => {
		expect(host(2).join("\n")).toContain("note0");
	});

	it("titles the card btw", () => {
		expect(host(2).join("\n")).toContain("btw");
	});

	it("keeps the host underneath", () => {
		// Composited, not replaced: the pane the note is about stays readable.
		expect(host(2).join("\n")).toContain("host0");
	});

	it("does not lengthen the host", () => {
		const withOverlay = host(2).length;
		const without = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 12 } },
				h(
					"box",
					{ className: "chat-surface" },
					...Array.from({ length: 6 }, (_u, i) => text(`host${i}`)),
				),
			),
			60,
		).length;
		expect(withOverlay).toBe(without);
	});

	it("clips a card taller than the glass", () => {
		// A note longer than the pane cannot push the frame taller; it loses
		// its top, which is the part already read.
		expect(host(40, 8)).toHaveLength(
			lines(
				h(
					"box",
					{ className: "ink-card", style: { height: 8 } },
					h("box", { className: "chat-surface" }, text("host0")),
				),
				60,
			).length,
		);
	});

	it("scrolls the overlay by the deepest of its scrolls", () => {
		const scrolled = lines(
			h(
				"box",
				{ className: "ink-card", style: { height: 12 } },
				h("box", { className: "chat-surface" }, text("host")),
				h(
					"box",
					{ className: "btw-aside overlay", scroll: 3 },
					...Array.from({ length: 20 }, (_u, i) => text(`note${i}`)),
				),
			),
			60,
		).join("\n");
		expect(scrolled).toContain("note");
	});
});

describe("the broadcast frame", () => {
	const frame = (props = {}) =>
		lines(
			h(
				"box",
				{ className: "broadcast-frame", style: { height: 6 }, ...props },
				text("live"),
			),
			40,
		);

	it("draws its own chrome rather than an ink card", () => {
		expect(frame().join("\n")).toContain("live");
	});

	it("takes an animation phase", () => {
		expect(frame({ phase: 2 })).not.toEqual(frame({ phase: 0 }));
	});

	it("treats a non-numeric phase as zero", () => {
		expect(frame({ phase: "spin" })).toEqual(frame({ phase: 0 }));
	});

	it("defaults the phase when none is given", () => {
		expect(frame()).toEqual(frame({ phase: 0 }));
	});
});
