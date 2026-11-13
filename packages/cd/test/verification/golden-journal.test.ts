// Golden journal corpus for the three event bodies WP9 appends
// (verification.Started, rollout.EvidenceObserved, verification.Completed).
// Two guarantees: a stream recorded today still folds and replays to its
// recorded verdict (old bodies stay readable), and the engine still writes
// byte-identical bodies for the same inputs (no silent body drift). Refresh
// deliberately with UPDATE_GOLDEN=1 and review the diff.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	Cohort,
	HealthSourceKind,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import {
	createVerificationEngine,
	foldVerification,
	replayVerification,
} from "../../src/verification/index.js";
import {
	camp,
	clock,
	comparisonSpec,
	context,
	fid,
	json,
	MemoryEventStore,
	MINUTE,
	OPERATOR,
	RecordingVerifyPort,
	ScriptedHealthSource,
	ScriptedTransport,
	samples,
	T0,
	TENANT,
	thresholdSpec,
} from "./fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, "golden/verification-journal.json");

type GoldenEvent = Readonly<{ type: string; seq: number; data: unknown }>;
type Corpus = Readonly<Record<string, readonly GoldenEvent[]>>;

async function record(name: string): Promise<readonly GoldenEvent[]> {
	const store = new MemoryEventStore();
	const time = clock();
	const ctx = context(time.now);
	const source = new ScriptedHealthSource(
		HealthSourceKind.PROMETHEUS,
		({ cohort }) => {
			if (name === "no-data") return samples([]);
			if (name === "deadline") return samples([0.01]);
			return samples(
				cohort === Cohort.CANARY
					? [150, 151, 152, 153, 154, 155, 156, 157]
					: [100, 101, 102, 103, 104, 105, 106, 107],
			);
		},
	);
	const engine = createVerificationEngine({
		store,
		tenant: TENANT,
		now: time.now,
		sources: [source],
		suites: new RecordingVerifyPort(),
		http: new ScriptedTransport(() => json(200, {})).transport,
	});
	const spec = name === "canary-worse" ? comparisonSpec() : thresholdSpec();
	const id = await engine.start(
		{
			spec,
			freightId: fid("sha256:golden"),
			campId: camp("camp-golden"),
			cohortAware: name === "canary-worse",
		},
		ctx,
	);
	time.advance(10 * MINUTE);
	await engine.tick(ctx);
	time.advance(20 * MINUTE);
	await engine.tick(ctx);
	return store
		.events(CD_STREAMS.verification(id))
		.map((event) => ({ type: event.type, seq: event.seq, data: event.data }));
}

const SCENARIOS = ["canary-worse", "no-data", "deadline"] as const;
const EXPECTED = {
	"canary-worse": VerificationVerdict.FAIL,
	"no-data": VerificationVerdict.FAIL,
	deadline: VerificationVerdict.INCONCLUSIVE,
} as const satisfies Readonly<
	Record<(typeof SCENARIOS)[number], VerificationVerdict>
>;

function envelopes(events: readonly GoldenEvent[]): EventEnvelope[] {
	return events.map((event, index) => ({
		id: `golden-${index}`,
		type: event.type,
		v: 1,
		streamId: "cd-verification-golden",
		seq: event.seq,
		ts: new Date(T0).toISOString(),
		actor: OPERATOR,
		tenant: TENANT,
		data: event.data,
	}));
}

describe("verification golden journal corpus", async () => {
	if (process.env.UPDATE_GOLDEN === "1") {
		const corpus: Record<string, readonly GoldenEvent[]> = {};
		for (const name of SCENARIOS) corpus[name] = await record(name);
		writeFileSync(corpusPath, `${JSON.stringify(corpus, null, "\t")}\n`);
	}
	const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

	for (const name of SCENARIOS) {
		it(`${name}: recorded bodies fold and replay to the recorded verdict`, () => {
			const events = envelopes(corpus[name] ?? []);
			expect(foldVerification(events)?.result?.verdict).toBe(EXPECTED[name]);
			expect(replayVerification(events)).toMatchObject({
				matches: true,
				recorded: EXPECTED[name],
			});
		});

		it(`${name}: the engine still writes byte-identical bodies`, async () => {
			expect(await record(name)).toEqual(corpus[name]);
		});
	}
});
