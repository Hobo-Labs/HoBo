import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	loadStationCapabilityManifest,
	matchStationCapabilities,
	persistStationCapabilityManifest,
	STATION_CAPABILITY_MANIFEST_SCHEMA,
	STATION_CAPABILITY_SCHEMA,
	station,
	stationCapability,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-station-cap-"));
	temps.push(d);
	return d;
}

const git = stationCapability({
	kind: "vcs",
	slug: "git",
	title: "git on PATH",
	required: true,
	remediation: "install git",
});
const ollama = stationCapability({
	kind: "model-server",
	slug: "ollama",
	title: "local model server",
	remediation: "ollama serve",
});
const replay = stationCapability({
	kind: "replay",
	slug: "session-replay",
	title: "Session Replay (ADR-0137)",
	provenance: "default",
});

describe("stationCapability()", () => {
	it("declares a frozen, schema-versioned capability with a stable id", () => {
		expect(git.schema).toBe(STATION_CAPABILITY_SCHEMA);
		expect(git.id).toBe("capability:vcs:git");
		expect(git.required).toBe(true);
		expect(Object.isFrozen(git)).toBe(true);
		expect(Object.isFrozen(git.metadata)).toBe(true);
	});

	it("parse-don't-validate: bad kind / slug / title throw at declaration time", () => {
		expect(() =>
			stationCapability({ kind: "gpu" as never, slug: "x", title: "x" }),
		).toThrow(/kind/);
		expect(() =>
			stationCapability({ kind: "vcs", slug: "Bad Slug", title: "x" }),
		).toThrow(/slug/);
		expect(() =>
			stationCapability({ kind: "vcs", slug: "git", title: "" }),
		).toThrow(/title/);
	});
});

describe("matchStationCapabilities()", () => {
	const now = () => "2026-08-15T00:00:00.000Z";

	it("fails closed: declared-but-unobserved discovered capability is missing", () => {
		const manifest = matchStationCapabilities({
			stationId: "station:local",
			declared: [git, ollama],
			observations: [],
			now,
		});
		expect(manifest.schema).toBe(STATION_CAPABILITY_MANIFEST_SCHEMA);
		expect(manifest.ok).toBe(false);
		expect(manifest.missingRequired).toEqual(["capability:vcs:git"]);
		expect(manifest.remediation).toEqual(["install git", "ollama serve"]);
	});

	it("default provenance is present-by-construction unless observed absent", () => {
		const supplied = matchStationCapabilities({
			stationId: "station:local",
			declared: [replay],
			observations: [],
			now,
		});
		expect(supplied.ok).toBe(true);
		expect(supplied.capabilities[0]?.status).toBe("present");
		expect(supplied.capabilities[0]?.evidence).toEqual(["default-supplied"]);

		const killed = matchStationCapabilities({
			stationId: "station:local",
			declared: [replay],
			observations: [
				{
					capabilityId: replay.id,
					present: false,
					evidence: ["env:HOBO_REPLAY=0"],
				},
			],
			now,
		});
		expect(killed.capabilities[0]?.status).toBe("missing");
	});

	it("required present + optional missing is ok with remediation preserved", () => {
		const manifest = matchStationCapabilities({
			stationId: "station:local",
			declared: [git, ollama],
			observations: [
				{
					capabilityId: git.id,
					present: true,
					evidence: ["bin:/usr/bin/git"],
				},
			],
			now,
		});
		expect(manifest.ok).toBe(true);
		expect(manifest.missingRequired).toEqual([]);
		expect(manifest.remediation).toEqual(["ollama serve"]);
		expect(manifest.generatedAt).toBe("2026-08-15T00:00:00.000Z");
	});

	it("round-trips through the station data dir", () => {
		const home = tempHome();
		const manifest = matchStationCapabilities({
			stationId: "station:local",
			declared: [git],
			observations: [
				{ capabilityId: git.id, present: true, evidence: ["bin:/usr/bin/git"] },
			],
			now,
		});
		persistStationCapabilityManifest(home, "station:local", manifest);
		const loaded = loadStationCapabilityManifest(home, "station:local");
		expect(loaded).toEqual(manifest);
		expect(loadStationCapabilityManifest(home, "station:none")).toBeNull();
	});
});

describe("station() capability + isolation-class passthrough", () => {
	it("carries declared capabilities and the ADR-0133 isolation class verbatim", () => {
		const declared = station("code-dev", {
			isolation: { isolationClass: "local-dev" },
			capabilities: [git, ollama],
		});
		expect(declared.isolation.isolationClass).toBe("local-dev");
		expect(declared.capabilities.map((c) => c.id)).toEqual([
			"capability:vcs:git",
			"capability:model-server:ollama",
		]);
		expect(Object.isFrozen(declared.capabilities)).toBe(true);
	});

	it("invents no isolation class when the declaration omits one", () => {
		const declared = station("bare");
		expect(declared.isolation.isolationClass).toBeUndefined();
		expect(declared.capabilities).toEqual([]);
	});
});
