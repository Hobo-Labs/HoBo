import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Cohort,
	HealthSourceKind,
	VerificationSpecRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import {
	createVerificationEngine,
	informVerificationSpec,
	parseVerificationSpec,
} from "../../src/verification/index.js";
import { jsonOf } from "../../src/verification/json.js";
import {
	bodyObject,
	camp,
	clock,
	comparisonSpec,
	context,
	fid,
	json,
	MemoryEventStore,
	MINUTE,
	query,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	samples,
	TENANT,
	thresholdSpec,
} from "./fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/verification.cue");

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
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-verification-cue-"));
let written = 0;

function vets(definition: string, value: JsonValue | undefined): boolean {
	if (!cue) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.cue`);
	writeFileSync(
		file,
		`package verification\n\nvalue: ${definition} & ${JSON.stringify(value)}\n`,
	);
	try {
		execFileSync(cue, ["export", schema, file, "-e", "value"], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

const specJson = (spec: ReturnType<typeof thresholdSpec>): JsonValue =>
	toJson(VerificationSpecRecordSchema, spec);

describe.skipIf(cue === undefined)(
	"verification.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("validates SLO gate policy and query units", () => {
			const slo = () =>
				create(VerificationSpecRecordSchema, {
					windowMs: BigInt(15 * MINUTE),
					sloGate: {
						burnRate: query("burn", { unit: "burn_rate" }),
						remainingBudgetRatio: query("remaining", { unit: "ratio" }),
					},
				});
			const valid = slo();
			const custom = slo();
			if (!custom.sloGate) throw new Error("missing gate");
			custom.sloGate.rollbackBurnRate = 6;
			custom.sloGate.holdBurnRate = 0.5;
			custom.sloGate.minRemainingBudgetRatio = 0;
			custom.sloGate.holdRemainingBudgetRatio = 0.1;
			const defaultWindowAge = slo();
			if (!defaultWindowAge.sloGate) throw new Error("missing gate");
			defaultWindowAge.windowMs = 0n;
			defaultWindowAge.sloGate.maxSampleAgeMs = BigInt(16 * MINUTE);
			const reversed = slo();
			if (!reversed.sloGate) throw new Error("missing gate");
			reversed.sloGate.holdBurnRate = 12;
			const count = slo();
			if (!count.sloGate) throw new Error("missing gate");
			count.sloGate.sustainedHealthyCount = 1;
			const unit = slo();
			if (!unit.sloGate?.burnRate) throw new Error("missing query");
			unit.sloGate.burnRate.unit = "ratio";
			const age = slo();
			if (!age.sloGate) throw new Error("missing gate");
			age.sloGate.maxSampleAgeMs = BigInt(16 * MINUTE);
			for (const [spec, expected] of [
				[valid, true],
				[custom, true],
				[defaultWindowAge, false],
				[reversed, false],
				[count, false],
				[unit, false],
				[age, false],
			] as const) {
				expect(parseVerificationSpec(spec).ok).toBe(expected);
				expect(vets("#VerificationSpecRecord", specJson(spec))).toBe(expected);
			}
		});

		it("vets every spec the parser accepts", () => {
			const accepted = [
				thresholdSpec(),
				comparisonSpec(),
				informVerificationSpec({ railDigest: `sha256:${"cd".repeat(32)}` }),
				thresholdSpec({
					probes: [
						{
							name: "health",
							urlRef: "https://api.example.com/healthz",
							minSuccessRatio: 0.9,
						},
					],
					suites: [{ suite: "smoke" }],
				}),
			];
			for (const spec of accepted) {
				expect(parseVerificationSpec(spec).ok).toBe(true);
				expect(vets("#VerificationSpecRecord", specJson(spec))).toBe(true);
			}
		});

		it("refuses what the parser refuses", () => {
			const refused = [
				create(VerificationSpecRecordSchema, {}),
				thresholdSpec({ progressDeadlineMs: BigInt(MINUTE) }),
				thresholdSpec({ maxErrorBudgetBurn: 2 }),
				thresholdSpec({ suites: [{ suite: "a" }, { suite: "a" }] }),
				thresholdSpec({
					probes: [{ name: "p", urlRef: "http://plain.example.com" }],
				}),
				comparisonSpec({
					comparisons: [
						{
							query: {
								name: "x",
								source: HealthSourceKind.DATADOG,
								endpointRef: "https://api.datadoghq.com",
								query: "q",
							},
						},
					],
				}),
			];
			for (const spec of refused) {
				expect(parseVerificationSpec(spec).ok).toBe(false);
				expect(vets("#VerificationSpecRecord", specJson(spec))).toBe(false);
			}
		});

		it("vets the Started, EvidenceObserved and Completed bodies the engine records", async () => {
			const store = new MemoryEventStore();
			const time = clock();
			const source = new ScriptedHealthSource(
				HealthSourceKind.PROMETHEUS,
				({ cohort }) =>
					samples(
						cohort === Cohort.CANARY
							? [150, 151, 152, 153, 154, 155, 156, 157]
							: [100, 101, 102, 103, 104, 105, 106, 107],
					),
			);
			const engine = createVerificationEngine({
				store,
				tenant: TENANT,
				now: time.now,
				sources: [source],
				suites: new RecordingVerifyPort(),
				http: new ScriptedTransport(() => json(200, {})).transport,
			});
			const ctx = context(time.now);
			const id = await engine.start(
				{
					spec: comparisonSpec(),
					freightId: fid("sha256:f1"),
					campId: camp("camp-a"),
					cohortAware: true,
				},
				ctx,
			);
			time.advance(10 * MINUTE);
			await engine.tick(ctx);
			const definitionFor = (type: string) =>
				type === "verification.Started"
					? "#VerificationStarted"
					: type === "rollout.EvidenceObserved"
						? "#EvidenceObservationRecord"
						: type === "verification.Completed"
							? "#VerificationResultRecord"
							: "#missing";
			const events = store.events(CD_STREAMS.verification(id));
			expect(events.length).toBeGreaterThan(2);
			for (const event of events)
				expect(
					vets(definitionFor(event.type), jsonOf(event.data)),
					event.type,
				).toBe(true);
			const completed = bodyObject(events[events.length - 1]?.data);
			expect(
				vets("#VerificationResultRecord", {
					...completed,
					verdict: "VERIFICATION_VERDICT_PASS",
					checks: [],
				}),
			).toBe(false);
		});
	},
);
