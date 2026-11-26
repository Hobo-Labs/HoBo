import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGherkinQuality } from "../lib/feature-quality.mts";
import { discoverCode, pickPrimaryCommand, type DiscoveryReport } from "../lib/code-discovery.mts";
import { buildExperienceCatalog } from "../lib/experience-catalog.mts";
import type { SurfaceMap } from "../lib/surface-map.mts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("gherkin quality", () => {
	it("flags template-only When", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "oxp-gq-"));
		writeFileSync(
			path.join(dir, "x-developer.feature"),
			`@optimizexp @dx @persona:developer @interface:cli
Feature: x
  Scenario: a
    When I exercise the surface as this persona would
    Then I receive clear status about what happened
  Scenario: b
    When I exercise the surface as this persona would
    Then I receive clear status about what happened
`,
		);
		const r = checkGherkinQuality(dir);
		assert.equal(r.ok, false);
		assert.equal(r.templateOnly, true);
	});

	it("accepts concrete commands and observable outcomes", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "oxp-gq2-"));
		const body = [
			"@optimizexp @dx @persona:developer @interface:cli",
			"Feature: Help",
			"  Scenario: Show help",
			"    When I run `hobo --help`",
			'    Then stdout contains "Usage"',
			"  Scenario: Reject an unknown command",
			"    When I run `hobo missing`",
			"    Then exit code is 2",
		].join("\n");
		writeFileSync(path.join(dir, "hobo-help-developer.feature"), body);
		const result = checkGherkinQuality(dir);
		assert.equal(result.ok, true, result.problems.join("; "));
	});
});

describe("pickPrimaryCommand preference", () => {
	it("discovers the real experience inventory", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-inventory-"));
		try {
			mkdirSync(path.join(root, "scripts"));
			writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "draft:experiences": "node scripts/list-experience-proofs.mts" } }));
			writeFileSync(path.join(root, "scripts/list-experience-proofs.mts"), "export {};\n");
			const report = discoverCode({ root, featureId: "inventory", featureDir: root, seed: "Find experience proofs by audience" });
			assert.equal(pickPrimaryCommand(report)?.command, "pnpm run draft:experiences");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers the hobo shell over agent:check script", () => {
		const report: DiscoveryReport = {
			featureId: "hobo-yard",
			seed: "agent inventory for coding agent",
			scannedAt: new Date().toISOString(),
			packageScripts: ["agent:check", "eval:agent:mock"],
			notes: [],
			bindings: [
				{
					kind: "package-script",
					id: "script:agent:check",
					scriptName: "agent:check",
					command: "pnpm run agent:check",
					confidence: "high",
					reason: "keyword",
					implementsSteps: [],
				},
				{
					kind: "shell-command",
					id: "shell:hobo yard",
					command: "hobo yard",
					confidence: "high",
					reason: "product CLI",
					implementsSteps: [],
				},
			],
		};
		const p = pickPrimaryCommand(report);
		assert.ok(p);
		assert.match(p!.command ?? "", /hobo yard/);
	});
});

describe("experience catalog", () => {
	it("includes cold-start and help P0 for interactive product", () => {
		const map: SurfaceMap = {
			schemaVersion: 1,
			projectId: "hobo",
			scannedAt: new Date().toISOString(),
			productName: "hobo",
			packageDir: "packages/hobo",
			binaries: [{ name: "hobo", binPath: "/tmp/hobo.js" }],
			defaultEntry: {
				command: "hobo",
				interactive: true,
				driver: "tui",
				notes: "test",
			},
			nonInteractiveHelp: { command: "hobo --help", driver: "cli" },
			commands: [
				{ id: "help", argv: ["help"], kind: "discoverability" },
				{ id: "agent", argv: ["agent"], kind: "verb" },
			],
			interactiveSurfaces: [
				{ id: "default-tty-chat", entry: "bare-tty", driver: "tui" },
			],
			requiredJourneys: ["default-entry-cold-start", "help-discoverability"],
			probes: [],
		};
		const cat = buildExperienceCatalog({
			project: { id: "hobo", path: "packages/hobo", kind: "package", label: "hobo" },
			personaIds: ["developer"],
			surfaceMap: map,
		});
		assert.ok(
			cat.experiences.some((e) => e.experienceId === "cold-start-tty-chat"),
		);
		assert.ok(
			cat.experiences.some((e) => e.experienceId === "help-discoverability"),
		);
		assert.ok(cat.experiences.every((e) => e.priority === "P0" || e.priority === "P1" || e.priority === "P2"));
	});
});
