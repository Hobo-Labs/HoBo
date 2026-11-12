// data-models/verification.cue and the TypeScript boundary must agree: what
// parseVerificationSpec accepts and what the engine records vets clean; what
// the parser refuses, CUE refuses too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { Cohort, HealthSourceKind, VerificationSpecRecordSchema } from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import { createVerificationEngine, informVerificationSpec, parseVerificationSpec } from "../../src/verification/index.js";
import {
	camp,
	clock,
	comparisonSpec,
	context,
	fid,
	json,
	MemoryEventStore,
	MINUTE,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	samples,
	TENANT,
	thresholdSpec,
} from "./fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/verification.cue");

/** `cue` on PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`. */
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

/**
 * Unify the value with the definition and export it. Exporting an instance
 * (rather than `cue vet -d`) evaluates the hidden constraints against the
 * data only, never the bare definition.
 */
function vets(definition: string, value: unknown): boolean {
	if (!cue) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.cue`);
	writeFileSync(file, `package verification\n\nvalue: ${definition} & ${JSON.stringify(value)}\n`);
	try {
		execFileSync(cue, ["export", schema, file, "-e", "value"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const specJson = (spec: ReturnType<typeof thresholdSpec>): JsonValue => toJson(VerificationSpecRecordSchema, spec);

describe.skipIf(cue === undefined)("verification.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)", () => {
	it("vets every spec the parser accepts", () => {
		const accepted = [
			thresholdSpec(),
			comparisonSpec(),
			informVerificationSpec({ railDigest: `sha256:${"cd".repeat(32)}` }),
			thresholdSpec({ probes: [{ name: "health", urlRef: "https://api.example.com/healthz", minSuccessRatio: 0.9 }], suites: [{ suite: "smoke" }] }),
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
			thresholdSpec({ probes: [{ name: "p", urlRef: "http://plain.example.com" }] }),
			comparisonSpec({ comparisons: [{ query: { name: "x", source: HealthSourceKind.DATADOG, endpointRef: "https://api.datadoghq.com", query: "q" } }] }),
		];
		for (const spec of refused) {
			expect(parseVerificationSpec(spec).ok).toBe(false);
			expect(vets("#VerificationSpecRecord", specJson(spec))).toBe(false);
		}
	});

	it("vets the Started, EvidenceObserved and Completed bodies the engine records", async () => {
		const store = new MemoryEventStore();
		const time = clock();
		const source = new ScriptedHealthSource(HealthSourceKind.PROMETHEUS, ({ cohort }) =>
			samples(cohort === Cohort.CANARY ? [150, 151, 152, 153, 154, 155, 156, 157] : [100, 101, 102, 103, 104, 105, 106, 107]),
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
		const id = await engine.start({ spec: comparisonSpec(), freightId: fid("sha256:f1"), campId: camp("camp-a"), cohortAware: true }, ctx);
		time.advance(10 * MINUTE);
		await engine.tick(ctx);
		const definitions: Record<string, string> = {
			"verification.Started": "#VerificationStarted",
			"rollout.EvidenceObserved": "#EvidenceObservationRecord",
			"verification.Completed": "#VerificationResultRecord",
		};
		const events = store.events(CD_STREAMS.verification(id));
		expect(events.length).toBeGreaterThan(2);
		for (const event of events) expect(vets(definitions[event.type] ?? "#missing", event.data), event.type).toBe(true);
		// A PASS without checks is not a valid result.
		expect(vets("#VerificationResultRecord", { ...(events[events.length - 1]?.data as object), verdict: "VERIFICATION_VERDICT_PASS", checks: [] })).toBe(false);
	});
});
