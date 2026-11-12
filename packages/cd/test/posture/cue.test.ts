// data-models/posture.cue agrees with what the posture module writes: every
// body appended in a full journey vets against its definition, and the
// constraints reject what the parse boundaries reject.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	PolicyMode,
	RailDeliveryRecordSchema,
	RailPostureBindingRecordSchema,
	RemediationMode,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS } from "../../src/events.js";
import { createShadowRecorder } from "../../src/posture/index.js";
import {
	camp,
	digest,
	observe,
	promotion,
	railDelivery,
	railFreight,
	resolvedSet,
} from "./fakes.js";
import { postureHarness } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));

function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools)) {
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			}
			directory = dirname(directory);
		}
		return undefined;
	}
}

const cue = findCue();
const schema = resolve(here, "../../data-models/posture.cue");
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-wp24-cue-"));
let written = 0;

function vet(definition: string, value: JsonValue): boolean {
	if (!cue) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.json`);
	writeFileSync(file, JSON.stringify(value));
	try {
		execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

const BODY_DEFINITION: Readonly<Record<string, string>> = {
	[CD_EVENTS.PolicyBindingChanged]: "#PolicyBindingRecord",
	[CD_EVENTS.PolicyShadowDecided]: "#ShadowDecisionRecord",
	[CD_EVENTS.ComplianceObserved]: "#ComplianceRecord",
	[CD_EVENTS.ComplianceChanged]: "#ComplianceRecord",
	[CD_EVENTS.PostureRemediationProposed]: "#PostureRemediationRecord",
};

describe.skipIf(cue === undefined)("posture.cue", () => {
	it("accepts every body a full posture journey appends", async () => {
		const h = postureHarness();
		const prod = camp("prod-1");
		const other = camp("prod-2");
		h.inventory.add(prod);
		h.inventory.add(other);
		h.rails.byCamp.set(
			prod,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.ENFORCE },
			]),
		);
		h.rails.byCamp.set(
			other,
			railDelivery(digest("a"), [
				{ pack: "tls-baseline", remediation: RemediationMode.ENFORCE },
			]),
		);
		h.rails.byDigest.set(
			digest("b"),
			railDelivery(digest("b"), [
				{ pack: "tls-strict", remediation: RemediationMode.INFORM },
			]),
		);
		h.desired.seed(prod, resolvedSet(prod, [{ name: "api" }]));
		h.desired.seed(
			other,
			resolvedSet(other, [
				{ name: "api", parameters: { tls: { min_version: "1.0" } } },
			]),
		);
		await h.campPolicy.bind(
			{
				campId: prod,
				freight: railFreight(digest("b")),
				mode: PolicyMode.INFORM,
				promotionId: promotion("p1"),
			},
			h.ctx(),
		);
		const route = {
			resource: "api",
			kind: "http-route",
			classification: "pii",
			attributes: { "tls.min_version": "1.0" },
		};
		await observe(h.store, prod, [route]);
		await observe(h.store, other, [route]);
		await h.service.tick(h.ctx());
		h.time.advance(CD_DEFAULTS.postureNoncompliantIntervalMs);
		await observe(h.store, prod, [
			{ ...route, attributes: { "tls.min_version": "1.3" } },
		]);
		await h.service.tick(h.ctx());
		const shadow = createShadowRecorder({
			...h.deps,
			resolvePack: async () => ({ id: "p", version: "1", rules: [] }),
		});
		for (const [deltaId, candidateEffect] of [
			["d1", "deny"],
			["d2", "allow"],
		] as const)
			await shadow.record(
				{
					$typeName: "hobo.cd.v1.ShadowDecisionRecord",
					campId: prod,
					deltaId,
					enforcedRailDigest: digest("a"),
					candidateRailDigest: digest("b"),
					enforcedEffect: "allow",
					candidateEffect,
					diverged: false,
					decidedAt: new Date(h.time.now()).toISOString(),
				},
				h.ctx(),
			);
		await h.campPolicy.restore(
			{ campId: prod, promotionId: promotion("p1") },
			h.ctx(),
		);
		const seen = new Set<string>();
		for (const { event } of h.store.all) {
			const definition = BODY_DEFINITION[event.type];
			if (!definition) continue;
			// SAFETY: bodies are JSON by construction.
			expect(
				vet(definition, event.data as JsonValue),
				`${event.type} ${JSON.stringify(event.data)}`,
			).toBe(true);
			seen.add(event.type);
		}
		expect([...seen].sort()).toEqual(Object.keys(BODY_DEFINITION).sort());
		const binding = railDelivery(digest("a"), [
			{
				pack: "tls-baseline",
				remediation: RemediationMode.ENFORCE,
				compliantMs: 60_000,
			},
		]).posture[0];
		if (!binding) throw new Error("binding");
		expect(
			vet(
				"#RailDeliveryRecord",
				toJson(
					RailDeliveryRecordSchema,
					railDelivery(digest("a"), [
						{ pack: "tls-baseline", remediation: RemediationMode.INFORM_ONLY },
					]),
				),
			),
		).toBe(true);
		expect(
			vet(
				"#RailPostureBindingRecord",
				toJson(RailPostureBindingRecordSchema, binding),
			),
		).toBe(true);
	});

	it("rejects what the posture boundaries reject", () => {
		const a = digest("a");
		const at = "2026-11-12T12:00:00.000Z";
		expect(
			vet("#PolicyBindingRecord", {
				campId: "c",
				candidateRailDigest: a,
				enforcedRailDigest: a,
				promotionId: "p",
				boundAt: at,
			}),
		).toBe(false);
		expect(
			vet("#PolicyBindingRecord", {
				campId: "c",
				candidateRailDigest: "md5:x",
				promotionId: "p",
				boundAt: at,
			}),
		).toBe(false);
		expect(
			vet("#ShadowDecisionRecord", {
				campId: "c",
				deltaId: "d",
				candidateRailDigest: a,
				enforcedEffect: "allow",
				candidateEffect: "allow",
				diverged: true,
				decidedAt: at,
			}),
		).toBe(false);
		expect(
			vet("#ShadowDecisionRecord", {
				campId: "c",
				deltaId: "d",
				candidateRailDigest: a,
				enforcedEffect: "allow",
				candidateEffect: "deny",
				decidedAt: at,
			}),
		).toBe(false);
		const finding = {
			rule: "tls/min",
			resource: "api",
			state: "COMPLIANCE_STATE_COMPLIANT",
			severity: "high",
			ownershipConflict: true,
		};
		expect(vet("#PostureFindingRecord", finding)).toBe(false);
		expect(
			vet("#PostureFindingRecord", {
				...finding,
				state: "COMPLIANCE_STATE_NONCOMPLIANT",
			}),
		).toBe(true);
		expect(
			vet("#PostureFindingRecord", {
				rule: "tls/min",
				state: "COMPLIANCE_STATE_NONCOMPLIANT",
				severity: "high",
			}),
		).toBe(false);
		const record = {
			campId: "c",
			railDigest: a,
			state: "COMPLIANCE_STATE_NONCOMPLIANT",
			observationPosition: "7",
			evaluatedAt: at,
		};
		expect(vet("#ComplianceRecord", record)).toBe(true);
		expect(
			vet("#ComplianceRecord", { ...record, observationPosition: "" }),
		).toBe(false);
		expect(
			vet("#ComplianceRecord", {
				...record,
				candidate: true,
				findings: [{ ...finding, state: "COMPLIANCE_STATE_NONCOMPLIANT" }],
			}),
		).toBe(false);
		expect(
			vet("#PostureRemediationRecord", {
				campId: "c",
				rule: "tls/min",
				resource: "api",
				mode: "REMEDIATION_MODE_INFORM",
				reasons: [{ code: "x" }],
			}),
		).toBe(false);
		expect(
			vet("#PostureRemediationRecord", {
				campId: "c",
				rule: "tls/min",
				resource: "api",
				mode: "REMEDIATION_MODE_ENFORCE",
				reasons: [],
			}),
		).toBe(false);
	});
});
