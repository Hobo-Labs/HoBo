/**
 * Rubber-duck / adversarial EXPERIENCE.md checks + Gherkin template-quality bans.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ADVERSARIAL_MARKERS = [
	"Did not skip default entry",
	"Not testing a monorepo script",
	"No When-step is only",
	"Scores cannot be invented",
	"Persona vocabulary",
	"Security:",
	"Cognitive load",
	"Confusion twin",
	"If this were the only feature",
];

const RUBBER_DUCK_HEADING = /##\s*Rubber-duck/i;
const ADVERSARIAL_HEADING = /##\s*Adversarial/i;
const VERDICT_HEADING = /##\s*Verdict/i;

export type RubberduckResult = {
	ok: boolean;
	problems: string[];
};

/** Validate EXPERIENCE.md rubber-duck + adversarial completeness. */
export function checkRubberduckDoc(experienceMd: string): RubberduckResult {
	const problems: string[] = [];
	if (!RUBBER_DUCK_HEADING.test(experienceMd)) {
		problems.push("missing ## Rubber-duck section");
	}
	if (!ADVERSARIAL_HEADING.test(experienceMd)) {
		problems.push("missing ## Adversarial section");
	}
	if (!VERDICT_HEADING.test(experienceMd)) {
		problems.push("missing ## Verdict section");
	}
	// Adversarial boxes must be checked [x]
	const unchecked = (experienceMd.match(/- \[ \]/g) ?? []).length;
	const checked = (experienceMd.match(/- \[[xX]\]/g) ?? []).length;
	if (checked < 6) {
		problems.push(
			`adversarial checklist needs ≥6 checked items (found ${checked} checked, ${unchecked} unchecked)`,
		);
	}
	// Rubber-duck body length
	const rd = experienceMd.split(RUBBER_DUCK_HEADING)[1] ?? "";
	const rdBody = rd.split(ADVERSARIAL_HEADING)[0] ?? "";
	if (rdBody.replace(/\s+/g, " ").trim().length < 280) {
		problems.push("rubber-duck answers too short (<280 non-space chars)");
	}
	// Must mention a command-like token
	if (!/`[^`]+`/.test(experienceMd) && !/\bhobo\b|\b[a-z]-code\b/i.test(experienceMd)) {
		problems.push("EXPERIENCE.md must quote an entry command in backticks or name the binary");
	}
	if (!/accept|revise|reject/i.test(experienceMd)) {
		problems.push("verdict must include accept|revise|reject");
	}
	// Prefer accept for scaffold
	if (/##\s*Verdict[\s\S]*reject/i.test(experienceMd) && !/accept/i.test(experienceMd)) {
		problems.push("verdict is reject — revise EXPERIENCE before scaffold");
	}
	void ADVERSARIAL_MARKERS;
	return { ok: problems.length === 0, problems };
}

export function checkRubberduckFile(featureDir: string): RubberduckResult {
	const p = path.join(featureDir, "EXPERIENCE.md");
	if (!existsSync(p)) {
		return { ok: false, problems: ["EXPERIENCE.md missing"] };
	}
	return checkRubberduckDoc(readFileSync(p, "utf8"));
}

const GENERIC_WHEN =
	/When I exercise the surface as this persona would/i;
const GENERIC_THEN_STATUS =
	/Then I receive clear status about what happened/i;
const CONCRETE_WHEN =
	/When I (?:run|start|open|invoke|execute|type|issue) |When I run `|When I start bare TTY|When I run slash command/i;
const BACKTICK_CMD = /When[^`\n]*`[^`]+`/;

export type GherkinQualityResult = {
	ok: boolean;
	problems: string[];
	templateOnly: boolean;
};

/** Scan all .feature files in a feature folder for template-only anti-patterns. */
export function checkGherkinQuality(featureDir: string): GherkinQualityResult {
	const problems: string[] = [];
	let templateOnly = false;
	if (!existsSync(featureDir)) {
		return { ok: false, problems: ["feature dir missing"], templateOnly: true };
	}
	const files = readdirSync(featureDir).filter((f) => f.endsWith(".feature"));
	if (files.length === 0) {
		return { ok: false, problems: ["no .feature files"], templateOnly: true };
	}
	for (const f of files) {
		const text = readFileSync(path.join(featureDir, f), "utf8");
		const scenarios = (text.match(/^\s*Scenario:/gim) ?? []).length;
		if (scenarios < 2) {
			problems.push(`${f}: need ≥2 scenarios (found ${scenarios})`);
		}
		const hasConcrete =
			CONCRETE_WHEN.test(text) || BACKTICK_CMD.test(text);
		const hasGenericWhen = GENERIC_WHEN.test(text);
		if (hasGenericWhen && !hasConcrete) {
			problems.push(
				`${f}: template-only When ("exercise the surface") without concrete command/TUI step`,
			);
			templateOnly = true;
		}
		// Count Then status-only vs concrete
		if (GENERIC_THEN_STATUS.test(text)) {
			const concreteThen =
				/Then (?:the |I (?:see|get|receive) |stdout|help |panel|error |exit)/i.test(
					text,
				) || /Then .{10,}(?:◈|not stock|remediation|verb)/i.test(text);
			if (!concreteThen && !hasConcrete) {
				problems.push(
					`${f}: Then steps too generic (clear status only) without observable chrome asserts`,
				);
				templateOnly = true;
			}
		}
		if (!/@persona:/.test(text)) {
			problems.push(`${f}: missing @persona: tag`);
		}
		if (!/@interface:/.test(text)) {
			problems.push(`${f}: missing @interface: tag`);
		}
	}
	return { ok: problems.length === 0, problems, templateOnly };
}

/** Skeleton EXPERIENCE.md for plan mode. */
export function experienceMdSkeleton(input: {
	featureId: string;
	experienceId: string;
	personaId: string;
	entryCommand: string;
	driver: string;
	intent: string;
}): string {
	return `# EXPERIENCE: ${input.featureId}

- experienceId: ${input.experienceId}
- personaId: ${input.personaId}
- entryCommand: \`${input.entryCommand}\`
- driver: ${input.driver}
- intent: ${input.intent}

## Rubber-duck (explain to a new teammate)

1. Who is the persona and what are they trying to finish in the next 2 minutes?
   - TODO
2. What exact command / UI path do they take from a clean machine?
   - \`${input.entryCommand}\`
3. What do they see first? (quote expected chrome, not vibes)
   - TODO
4. What would make them think they opened the wrong product?
   - TODO
5. Happy path: step-by-step (Given/When/Then in prose first).
   - TODO
6. Failure path: how do they break it, what must the product say?
   - TODO
7. What evidence will prove a human/agent actually ran this? (driver + command)
   - driver: ${input.driver}; command: \`${input.entryCommand}\`
8. What is deliberately out of scope for this feature folder?
   - TODO

## Adversarial critique (must check all)

- [ ] Did not skip default entry because a secondary verb is easier to automate
- [ ] Not testing a monorepo script instead of the product binary
- [ ] No When-step is only “exercise the surface” without a real command
- [ ] Scores cannot be invented without reading stdout/TUI
- [ ] Persona vocabulary/asserts considered for shared paths
- [ ] Security: secrets, destructive promote, network—fail-closed
- [ ] Cognitive load: journey stays within persona thresholds
- [ ] Confusion twin: stock UI / wrong binary / wrong verb—covered
- [ ] If this feature were the only one we ship, the persona would not still be lost

## Verdict

- accept | revise | reject
- primaryCommand: \`${input.entryCommand}\`
- driver: ${input.driver}
- scenarios:
  - TODO happy
  - TODO failure
  - TODO discoverability (if P0 entry/chat)
`;
}

/** High-quality Gherkin template by kind. */
export function gherkinTemplate(input: {
	kind:
		| "default-entry-tui"
		| "default-entry-cli"
		| "help-discoverability"
		| "inventory-verb"
		| "failure-actionable"
		| "generic";
	featureId: string;
	title: string;
	personaId: string;
	personaName: string;
	personaRole?: string;
	iface: string;
	experiences: string[];
	bin: string;
	verb?: string;
	entryCommand: string;
}): string {
	const expTags = input.experiences.map((e) => `@${e}`).join(" ");
	const roleTag = input.personaRole ? ` @persona-role:${input.personaRole}` : "";
	const roleLabel = input.personaRole ? ` — ${input.personaRole}` : "";
	const head = `@optimizexp ${expTags} @persona:${input.personaId} @interface:${input.iface}${roleTag}
Feature: ${input.title} (${input.personaName}${roleLabel})
  As ${input.personaName}
  I want a real product path I can exercise and capture
  So that review scores come from evidence, not template vibes

  Background:
    Given persona "${input.personaId}" is active
    And feature "${input.featureId}" is under optimizexp review
`;

	if (input.kind === "default-entry-tui") {
		return `${head}
  Scenario: Cold-start bare TTY shows product discoverability for ${input.personaId}${roleLabel}
    Given I am on the critical path described by the feature seed
    When I start bare TTY \`${input.bin}\`
    Then stdout or session chrome mentions the product or its discoverability
    And I do not only see stock third-party agent branding
    And evidence is capturable for this scenario

  Scenario: In-session slash or verbs path is discoverable for ${input.personaId}${roleLabel}
    Given I am on the critical path described by the feature seed
    When I run slash command \`/verbs\` or one-shot \`${input.bin} help\`
    Then I see product verbs or slash command map
    And evidence is capturable for this scenario

  Scenario: Help one-shot lists verbs for ${input.personaId}${roleLabel}
    Given I am on the critical path described by the feature seed
    When I run \`${input.bin} help\`
    Then help lists verbs or usage
    And the next action is obvious without tribal knowledge
    And evidence is capturable for this scenario
`;
	}

	if (input.kind === "help-discoverability") {
		return `${head}
  Scenario: Help lists verbs for ${input.personaId}
    Given I am on the critical path described by the feature seed
    When I run \`${input.entryCommand}\`
    Then help lists verbs or usage
    And I see first-run or examples guidance
    And evidence is capturable for this scenario

  Scenario: Unknown verb fails actionably for ${input.personaId}
    Given something goes wrong on this journey
    When I run \`${input.bin} not-a-real-verb-zz\`
    Then the error is non-blaming and actionable
    And evidence of what I saw is stored under evidence/
`;
	}

	if (input.kind === "failure-actionable") {
		return `${head}
  Scenario: Unknown verb fails actionably for ${input.personaId}
    Given something goes wrong on this journey
    When I run \`${input.entryCommand}\`
    Then the error is non-blaming and actionable
    And I am not forced into repeated artificial hurdles
    And evidence of what I saw is stored under evidence/

  Scenario: Help remains available after failure for ${input.personaId}
    Given I am on the critical path described by the feature seed
    When I run \`${input.bin} help\`
    Then help lists verbs or usage
    And evidence is capturable for this scenario
`;
	}

	if (input.kind === "inventory-verb" || input.kind === "default-entry-cli") {
		const v = input.verb ?? input.entryCommand;
		const jsonCmd = input.entryCommand.includes("--json")
			? input.entryCommand
			: `${input.entryCommand} --json`;
		return `${head}
  Scenario: ${v} shows clear product chrome for ${input.personaId}
    Given I am on the critical path described by the feature seed
    When I run \`${input.entryCommand}\`
    Then I see product chrome or structured status for this surface
    And the next action is obvious without tribal knowledge
    And evidence is capturable for this scenario

  Scenario: ${v} JSON or help is machine-usable for ${input.personaId}
    Given I am on the critical path described by the feature seed
    When I run \`${jsonCmd}\`
    Then output is structured or documents flags without secret values
    And evidence is capturable for this scenario

  Scenario: Failure path for ${v} is actionable for ${input.personaId}
    Given something goes wrong on this journey
    When I observe the failure as this persona
    Then the error is non-blaming and actionable
    And evidence of what I saw is stored under evidence/
`;
	}

	// generic fallback — still prefers concrete command
	return `${head}
  Scenario: Primary path works for ${input.personaId}
    Given I am on the critical path described by the feature seed
    When I run \`${input.entryCommand}\`
    Then I see product chrome or structured status for this surface
    And the next action is obvious without tribal knowledge
    And evidence is capturable for this scenario

  Scenario: Failure is understandable for ${input.personaId}
    Given something goes wrong on this journey
    When I observe the failure as this persona
    Then the error is non-blaming and actionable
    And evidence of what I saw is stored under evidence/
`;
}

// ── Scenario ↔ product binding ───────────────────────────────────────────

export type ScenarioBindingResult = {
	ok: boolean;
	problems: string[];
};

/**
 * A product-scoped feature must actually exercise the product. Personas used
 * to be filename decoration: a product feature could ship scenarios that
 * only ran `pnpm` repo scripts and still certify. When the owning project
 * declares its `productBinary`, every `.feature` file and the feature.json
 * `primaryCommand` must reference it.
 */
export function checkScenarioBinding(
	featureDir: string,
	productBinary: string,
): ScenarioBindingResult {
	const problems: string[] = [];
	if (!existsSync(featureDir)) {
		return { ok: false, problems: ["feature dir missing"] };
	}
	const featureJsonPath = path.join(featureDir, "feature.json");
	if (existsSync(featureJsonPath)) {
		try {
			const meta = JSON.parse(readFileSync(featureJsonPath, "utf8")) as {
				primaryCommand?: string;
			};
			if (
				typeof meta.primaryCommand === "string" &&
				meta.primaryCommand.length > 0 &&
				!meta.primaryCommand.includes(productBinary)
			) {
				problems.push(
					`feature.json primaryCommand ("${meta.primaryCommand}") does not invoke ${productBinary}`,
				);
			}
		} catch {
			problems.push("feature.json unreadable");
		}
	}
	for (const f of readdirSync(featureDir).filter((n) => n.endsWith(".feature"))) {
		const text = readFileSync(path.join(featureDir, f), "utf8");
		if (!text.includes(productBinary)) {
			problems.push(
				`${f}: no scenario invokes ${productBinary} — persona scenarios must exercise the product, not repo scripts`,
			);
		}
	}
	return { ok: problems.length === 0, problems };
}
