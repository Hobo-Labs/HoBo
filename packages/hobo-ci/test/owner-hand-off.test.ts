import { describe, expect, it } from "vitest";

import {
	canReachOwner,
	OWNER_PAGE_LINE_PREFIX,
	showOwnerPage,
} from "../src/index.js";

// An agent runs `hobo ci up --hand-off` / `hobo cd up --hand-off` for the
// owner: the page is served without a terminal and named on one line the
// agent passes on, and nothing tries to open a browser on its machine.

describe("owner hand-off", () => {
	it("lets a handed-off run reach the owner without a terminal, and an explicit no wins", () => {
		expect(canReachOwner(undefined, true)).toBe(true);
		expect(canReachOwner(false, true)).toBe(false);
		expect(canReachOwner(true, false)).toBe(true);
	});

	it("names the page on one line and opens no browser when handed off", () => {
		const lines: string[] = [];
		const opened: string[] = [];
		showOwnerPage({
			url: "http://127.0.0.1:43117/s/abc",
			what: "Set up Vercel for HoBo CD",
			handOff: true,
			emit: (line) => lines.push(line),
			openBrowser: (url) => opened.push(url),
		});
		expect(opened).toEqual([]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			new RegExp(
				`^${OWNER_PAGE_LINE_PREFIX} http://127\\.0\\.0\\.1:43117/ port=43117 `,
			),
		);
	});

	it("opens the browser in a terminal", () => {
		const opened: string[] = [];
		showOwnerPage({
			url: "http://127.0.0.1:1/s/x",
			what: "Set up GitHub for HoBo CI",
			handOff: false,
			emit: () => undefined,
			openBrowser: (url) => opened.push(url),
		});
		expect(opened).toEqual(["http://127.0.0.1:1/s/x"]);
	});
});
