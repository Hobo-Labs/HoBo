/**
 * `parseDashboardLocation` and `data-models/ci_dashboard.cue` agree: what the
 * parser returns vets against `#DashboardLocation`, and a what-if question
 * the panel can build vets against `#WhatIfQuestion`, with the CUE rules
 * refusing what the parser refuses.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDashboardLocation, parseRepository } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = join(here, "..", "data-models", "ci_dashboard.cue");

function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		for (
			let directory = here;
			dirname(directory) !== directory;
			directory = dirname(directory)
		) {
			const tools = join(directory, ".tools", "cue");
			if (!existsSync(tools)) continue;
			for (const version of readdirSync(tools).sort().reverse()) {
				const binary = join(tools, version, "cue");
				if (existsSync(binary)) return binary;
			}
		}
		return undefined;
	}
}

const cue = findCue();
const scratch = mkdtempSync(join(tmpdir(), "hobo-ci-dashboard-cue-"));
let written = 0;

function vets(definition: string, json: string): boolean {
	if (cue === undefined) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.json`);
	writeFileSync(file, json);
	try {
		execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

describe("the dashboard's address", () => {
	it("parses each view and an opened run attempt", () => {
		expect(parseDashboardLocation("#/signals", "octo/app")).toEqual({
			view: "signals",
			repository: "octo/app",
			run: undefined,
		});
		const opened = parseDashboardLocation(
			"#/history/octo/app/102/2",
			undefined,
		);
		expect(opened.view).toBe("history");
		expect(opened.run).toEqual({ repository: "octo/app", id: 102, attempt: 2 });
		expect(Object.isFrozen(opened)).toBe(true);
	});

	it("falls back to the Runners view and drops a malformed repository", () => {
		expect(parseDashboardLocation("#/nowhere", " ").view).toBe("runners");
		expect(
			parseDashboardLocation("#/history/octo/app/0/1", undefined).run,
		).toBe(undefined);
		expect(
			parseDashboardLocation("#/history/octo/app/1/1001", undefined).run,
		).toBe(undefined);
		expect(parseRepository("octo/app/extra")).toBe(undefined);
		expect(parseRepository("<script>/x")).toBe(undefined);
		expect(parseRepository(" octo/app ")).toBe("octo/app");
	});
});

describe.skipIf(cue === undefined)("data-models/ci_dashboard.cue", () => {
	it("accepts every location the parser returns", () => {
		for (const hash of [
			"#/runners",
			"#/router",
			"#/history/octo/app/102/1",
			"#/performance",
			"#/signals",
		]) {
			const parsed = parseDashboardLocation(hash, "octo/app");
			expect(vets("#DashboardLocation", JSON.stringify(parsed)), hash).toBe(
				true,
			);
		}
	});

	it("refuses what the parser refuses", () => {
		expect(vets("#DashboardLocation", '{"view":"settings"}')).toBe(false);
		expect(
			vets(
				"#DashboardLocation",
				'{"view":"runners","repository":"octo/app/extra"}',
			),
		).toBe(false);
		expect(
			vets(
				"#DashboardLocation",
				'{"view":"runners","run":{"repository":"octo/app","id":1,"attempt":1}}',
			),
		).toBe(false);
		expect(
			vets(
				"#DashboardLocation",
				'{"view":"history","run":{"repository":"octo/app","id":0,"attempt":1}}',
			),
		).toBe(false);
	});

	it("bounds the what-if question as the walk's inputs are bounded", () => {
		const question = {
			repository: "octo/app",
			labels: [{ key: "github", labels: "ubuntu-24.04" }],
			public: false,
			fork: false,
			startedBy: "42",
			fleetTaking: true,
			unhealthy: ["depot"],
			minutesUsedPercent: 90,
		};
		expect(vets("#WhatIfQuestion", JSON.stringify(question))).toBe(true);
		expect(
			vets(
				"#WhatIfQuestion",
				JSON.stringify({ ...question, unhealthy: ["gpu"] }),
			),
		).toBe(false);
		expect(
			vets(
				"#WhatIfQuestion",
				JSON.stringify({ ...question, minutesUsedPercent: 101 }),
			),
		).toBe(false);
		expect(
			vets(
				"#WhatIfQuestion",
				JSON.stringify({ ...question, startedBy: "octocat" }),
			),
		).toBe(false);
	});
});
