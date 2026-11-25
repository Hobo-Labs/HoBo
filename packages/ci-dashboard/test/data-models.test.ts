import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDashboardLocation, parseRepository } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataModels = join(here, "..", "data-models");
const schemas = readdirSync(dataModels)
	.filter((name) => name.endsWith(".cue"))
	.map((name) => join(dataModels, name));
const fixtures = join(dataModels, "fixtures");

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
		execFileSync(cue, ["vet", "-c", "-d", definition, ...schemas, file], {
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

	for (const corpus of readdirSync(fixtures).sort()) {
		const definition = `#${corpus
			.split("_")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join("")}`;
		it(`vets the ${corpus} fixtures against ${definition}`, () => {
			for (const kind of ["valid", "invalid"] as const) {
				const folder = join(fixtures, corpus, kind);
				const files = readdirSync(folder).filter((name) =>
					name.endsWith(".json"),
				);
				expect(files.length, `${corpus}/${kind}`).toBeGreaterThan(0);
				for (const name of files)
					expect(
						vets(definition, readFileSync(join(folder, name), "utf8")),
						`${corpus}/${kind}/${name}`,
					).toBe(kind === "valid");
			}
		});
	}
});
