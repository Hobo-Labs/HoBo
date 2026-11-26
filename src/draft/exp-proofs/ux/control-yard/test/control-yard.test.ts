import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	CONTROL_YARD_ADR,
	assertYardZones,
	controlYardAcceptance,
	REQUIRED_ZONES,
} from "../src/control-yard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("control-yard experience proof", () => {
	it("pins ADR and required zones", () => {
		const a = controlYardAcceptance();
		expect(a.adr).toBe(CONTROL_YARD_ADR);
		expect(a.zones).toEqual([...REQUIRED_ZONES]);
		expect(a.noSecondLifecycle).toBe(true);
		expect(a.boWestIsNotMirror).toBe(true);
		expect(assertYardZones(a.zones).ok).toBe(true);
	});

	it("ships real visual asset for UX gate", () => {
		const svg = join(ROOT, "assets/yard-zones.svg");
		expect(existsSync(svg)).toBe(true);
		const body = readFileSync(svg, "utf8");
		expect(body).toContain("Connection Bay");
		expect(body).toContain("Active Rail Track");
	});

	it("references production packages", () => {
		const a = controlYardAcceptance();
		expect(a.packages).toContain("@hobo/management");
		expect(a.packages).toContain("@hobo/control-yard");
	});
});
