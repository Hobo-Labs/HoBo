/**
 * Unit tests: feature quality, discovery preference, rubberduck-check.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkGherkinQuality,
	checkRubberduckDoc,
	gherkinTemplate,
} from "../lib/feature-quality.mts";
import { pickPrimaryCommand, type DiscoveryReport } from "../lib/code-discovery.mts";
import { buildExperienceCatalog } from "../lib/experience-catalog.mts";
import type { SurfaceMap } from "../lib/surface-map.mts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("feature-quality rubberduck", () => {
	it("rejects empty EXPERIENCE.md", () => {
		const r = checkRubberduckDoc("# hi\n");
		assert.equal(r.ok, false);
		assert.ok(r.problems.some((p) => /Rubber-duck/i.test(p)));
	});

	it("accepts filled EXPERIENCE with checked boxes and accept", () => {
		const md = `# EXPERIENCE: x

entryCommand: \`hobo --help\`

## Rubber-duck (explain to a new teammate)

1. Who — developer finishing help discoverability in two minutes.
2. Path — \`hobo --help\` from clean shell.
3. First see — verb list and First run section.
4. Wrong product — a generic monorepo script help page.
5. Happy — run help, see verbs.
6. Failure — unknown verb gives remediation.
7. Evidence — cli capture of help stdout.
8. Out of scope — full Pi multi-turn chat.

## Adversarial critique (must check all)

- [x] Did not skip default entry because a secondary verb is easier to automate
- [x] Not testing a monorepo script instead of the product binary
- [x] No When-step is only “exercise the surface” without a real command
- [x] Scores cannot be invented without reading stdout/TUI
- [x] Persona vocabulary/asserts considered for shared paths
- [x] Security: secrets, destructive promote, network—fail-closed
- [x] Cognitive load: journey stays within persona thresholds
- [x] Confusion twin: stock UI / wrong binary / wrong verb—covered
- [x] If this feature were the only one we ship, the persona would not still be lost

## Verdict

- accept
- primaryCommand: \`hobo --help\`
`;
		const r = checkRubberduckDoc(md);
		assert.equal(r.ok, true, r.problems.join("; "));
	});
});

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

	it("accepts concrete When run backticks", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "oxp-gq2-"));
		const body = gherkinTemplate({
			kind: "help-discoverability",
			featureId: "hobo-help",
			title: "help",
			personaId: "developer",
			personaName: "developer",
			iface: "cli",
			experiences: ["dx"],
			bin: "hobo",
			entryCommand: "hobo --help",
		});
		writeFileSync(path.join(dir, "hobo-help-developer.feature"), body);
		const r = checkGherkinQuality(dir);
		assert.equal(r.ok, true, r.problems.join("; "));
	});

	it("keeps persona-specific role context in generated scenarios", () => {
		const base = {
			kind: "help-discoverability" as const,
			featureId: "help",
			title: "help",
			personaId: "p",
			personaName: "p",
			iface: "cli",
			experiences: ["dx"],
			bin: "hobo",
			entryCommand: "hobo --help",
		};
		const developer = gherkinTemplate({ ...base, personaRole: "application-developer" });
		const operator = gherkinTemplate({ ...base, personaRole: "agent-operator" });
		assert.notEqual(developer, operator);
		assert.match(developer, /persona-role:application-developer/);
		assert.match(operator, /persona-role:agent-operator/);
	});
});

describe("pickPrimaryCommand preference", () => {
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
