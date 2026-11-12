// Architecture tests over the WP10 sources: D8 (Station cutover is the only
// traffic mutator), I8 (no clock, RNG or network in decisions), I11 (neutral
// core) and the shared-constants rule (CD_RAMP_DEFAULTS, never local ramps).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../src");
const rolloutDir = join(src, "rollout");

function sources(): ReadonlyArray<Readonly<{ file: string; text: string }>> {
	const files = readdirSync(rolloutDir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(rolloutDir, name));
	files.push(
		join(src, "adapters", "harness.ts"),
		join(src, "adapters", "traffic.ts"),
	);
	return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/** Source text without comments, so prose never trips a code rule. */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("WP10 architecture", () => {
	it("D8: nothing but the Station cutover calls TrafficRoutingPort.apply", () => {
		for (const { file, text } of sources()) {
			const calls = code(text).match(/\.port\.apply\(|\bport\.apply\(/g) ?? [];
			if (file.endsWith("traffic.ts")) {
				// The single call is the acknowledgement-capturing port handed to executeRoutingCutover.
				expect(calls, file).toHaveLength(1);
				expect(code(text)).toMatch(/executeRoutingCutover\(\{[\s\S]*\bport,/);
			} else expect(calls, file).toHaveLength(0);
		}
	});

	it("D8: the ramp engine is OpenDeliveryEngine; no second rollout state machine and no gateway weights", () => {
		const harness =
			sources().find((s) => s.file.endsWith("harness.ts"))?.text ?? "";
		expect(harness).toContain("new OpenDeliveryEngine(");
		expect(code(harness)).not.toMatch(/"gateway-weighted"/);
		for (const { file, text } of sources())
			if (!file.endsWith("harness.ts"))
				expect(code(text), file).not.toMatch(
					/OpenDeliveryEngine|applyRolloutEvent/,
				);
	});

	it("I8: no wall clock, RNG or ambient network in rollout decisions", () => {
		for (const { file, text } of sources()) {
			const body = code(text);
			expect(body, file).not.toMatch(
				/Date\.now\(|Math\.random|randomUUID|new Date\(\)|globalThis\.fetch|\bfetch\(/,
			);
		}
	});

	it("I11: the rollout core imports no provider, runtime, CI, broker, CLI or host package and names no vendor", () => {
		for (const { file, text } of sources()) {
			expect(text, file).not.toMatch(
				/from "@hobo\/(provider-|iac-|runtime-|ci|broker|cli|hobo|resolver-components)/,
			);
			if (file.includes(`${join("src", "rollout")}`))
				expect(code(text), file).not.toMatch(
					/kubernetes|argo|flux|flagger|istio|datadog|newrelic|new relic|prometheus|cloudwatch/i,
				);
		}
	});

	it("ramps come from CD_RAMP_DEFAULTS, never local constants", () => {
		for (const { file, text } of sources())
			expect(code(text), file).not.toMatch(
				/\[\s*5\s*,\s*25\s*,\s*50|\[\s*10\s*,\s*50\s*,\s*100/,
			);
		const lowering =
			sources().find((s) => s.file.endsWith("lowering.ts"))?.text ?? "";
		expect(lowering).toContain("CD_RAMP_DEFAULTS.canary");
		const orchestrator =
			sources().find((s) => s.file.endsWith("orchestrator.ts"))?.text ?? "";
		expect(orchestrator).toContain(
			"CD_DEFAULTS.verificationProgressDeadlineMs",
		);
		expect(orchestrator).toContain("CD_DEFAULTS.approvalTtlMs");
	});

	it("I2/I7: the orchestrator opens rollback Deltas but never applies a Set itself", () => {
		const orchestrator = code(
			sources().find((s) => s.file.endsWith("orchestrator.ts"))?.text ?? "",
		);
		expect(orchestrator).toContain("d.desired.open(");
		expect(orchestrator).not.toMatch(/d\.desired\.apply\(|\.converge\(/);
	});
});
