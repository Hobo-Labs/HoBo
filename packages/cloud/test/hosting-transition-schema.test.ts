import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { HostingTransitionPlanSchema } from "../src/_generated/hosting_transition_pb.js";
import { createHostingTransitionPlan } from "../src/hosting-transition/model.js";

function fixture(name: string) {
	return JSON.parse(
		readFileSync(
			new URL(
				`../contracts/hosting-transition-fixtures/${name}.json`,
				import.meta.url,
			),
			"utf8",
		),
	);
}

describe("hosting transition protobuf/CUE record corpus", () => {
	it.each([
		"valid-plan",
		"valid-decommission",
		"valid-native-liability",
		"valid-source-liability",
		"invalid-source-combined-bound",
		"invalid-source-horizon",
		"invalid-source-mode",
		"invalid-source-incarnation",
		"invalid-native-horizon",
		"invalid-native-mode",
		"invalid-provider-funded-price",
		"invalid-decommission-approval",
		"invalid-move-zero-floor",
		"invalid-resume-bound",
		"invalid-foreign-commitment",
		"invalid-money-bound",
		"invalid-movement",
		"invalid-adoption-artifact",
	])("checks the actual transition record %s with CUE", (name) => {
		const cue =
			process.env.HOBO_CUE_BIN ??
			fileURLToPath(
				new URL(
					`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
					import.meta.url,
				),
			);
		const result = spawnSync(
			cue,
			[
				"vet",
				"-d",
				"#HostingTransitionPlan",
				fileURLToPath(
					new URL("../data-models/hosting_transition.cue", import.meta.url),
				),
				fileURLToPath(
					new URL(
						`../contracts/hosting-transition-fixtures/${name}.json`,
						import.meta.url,
					),
				),
			],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		expect(result.status, result.stderr).toBe(
			name.startsWith("valid-") ? 0 : 1,
		);
	});

	it.each([
		"valid-plan",
		"valid-decommission",
		"valid-native-liability",
		"valid-source-liability",
	])("round-trips the real parsed valid record %s and preserves the approval digest", (name) => {
		const wire = fromJson(HostingTransitionPlanSchema, fixture(name));
		expect(createHostingTransitionPlan(wire).planDigest).toBe(wire.planDigest);
	});
	it.each([
		"invalid-source-incarnation",
		"invalid-source-combined-bound",
		"invalid-source-horizon",
		"invalid-source-mode",
		"invalid-native-horizon",
		"invalid-native-mode",
		"invalid-provider-funded-price",
		"invalid-foreign-commitment",
		"invalid-decommission-approval",
		"invalid-move-zero-floor",
		"invalid-resume-bound",
		"invalid-money-bound",
		"invalid-movement",
		"invalid-adoption-artifact",
	])("rejects invalid CUE corpus record %s at the runtime parser boundary", (name) => {
		expect(() =>
			createHostingTransitionPlan(
				fromJson(HostingTransitionPlanSchema, fixture(name)),
			),
		).toThrow();
	});
});
