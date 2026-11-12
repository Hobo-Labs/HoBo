// Golden journal corpus for every event body WP10 appends: rollout.Lowered and
// the private cd.rollout.* ledger on cd-rollout-<id>, plus the engine command
// ledger on cd-rollout-engine-<id>. Two guarantees: a stream recorded today
// still folds and replays to its recorded outcome (old bodies stay readable),
// and the orchestrator still writes byte-identical bodies for the same inputs
// (no silent body drift). Refresh deliberately with UPDATE_GOLDEN=1 and review
// the diff.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	RolloutStrategy,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { HARNESS_LEDGER } from "../../src/adapters/harness.js";
import type { RolloutId } from "../../src/ports.js";
import { foldRollout, ROLLOUT_LEDGER } from "../../src/rollout/journal.js";
import { jsonOf } from "../../src/rollout/json.js";
import {
	MemoryEventStore,
	MINUTE,
	OPERATOR,
	promotion,
	spec,
	TENANT,
} from "./fakes.js";
import { rig } from "./rig.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, "golden/rollout-journal.json");

type GoldenEvent = Readonly<{
	stream: "rollout" | "engine";
	type: string;
	seq: number;
	data: ReturnType<typeof jsonOf>;
}>;
type Recording = Readonly<{
	rolloutId: string;
	status: string;
	events: readonly GoldenEvent[];
}>;
type Corpus = Readonly<Record<string, Recording>>;

const SCENARIOS = ["promoted", "rolled-back", "held-then-promoted"] as const;

async function record(name: (typeof SCENARIOS)[number]): Promise<Recording> {
	const r = rig();
	r.verification.script = ({ call }) =>
		name === "rolled-back" && call === 1
			? VerificationVerdict.FAIL
			: VerificationVerdict.PASS;
	r.desired.promoted("prod-a", "freight-1");
	const planned = await r.orchestrator.plan(
		{
			promotion: promotion({
				targets: ["prod-a"],
				strategy: RolloutStrategy.CANARY,
			}),
			obligations: [],
			verification: spec(),
			stagePercents: [],
			windows: ["prod"],
		},
		r.ctx,
	);
	if (!planned.ok) throw new Error("plan refused");
	if (name === "held-then-promoted") r.windows.open = false;
	await r.orchestrator.run(planned.value, r.ctx);
	r.windows.open = true;
	r.time.advance(MINUTE);
	await r.orchestrator.tick(r.ctx);
	const id = planned.value.rolloutId;
	const pick = (
		stream: "rollout" | "engine",
		events: readonly EventEnvelope[],
	) =>
		events.map((event) => ({
			stream,
			type: event.type,
			seq: event.seq,
			data: jsonOf(event.data),
		}));
	return {
		rolloutId: id,
		status: (await r.orchestrator.get(rid(id)))?.status ?? "missing",
		events: [
			...pick("rollout", r.store.events(ROLLOUT_LEDGER.stream(id))),
			...pick("engine", r.store.events(HARNESS_LEDGER.stream(id))),
		],
	};
}

function rid(id: string): RolloutId {
	// SAFETY: literal ids read back from the recording.
	return id as RolloutId;
}

describe("rollout golden journal corpus", () => {
	it("the orchestrator writes byte-identical bodies for the same inputs", async () => {
		const live: Record<string, Recording> = {};
		for (const name of SCENARIOS) live[name] = await record(name);
		if (process.env.UPDATE_GOLDEN === "1")
			writeFileSync(corpusPath, `${JSON.stringify(live, null, 2)}\n`);
		const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
		expect(live).toEqual(corpus);
	});

	it("recorded streams fold and replay to their recorded outcome on a fresh store", async () => {
		const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
		for (const [name, recording] of Object.entries(corpus)) {
			const store = new MemoryEventStore();
			for (const stream of ["rollout", "engine"] as const) {
				const streamId =
					stream === "rollout"
						? ROLLOUT_LEDGER.stream(recording.rolloutId)
						: HARNESS_LEDGER.stream(recording.rolloutId);
				const events = recording.events.filter((e) => e.stream === stream);
				for (const event of events)
					await store.append(
						streamId,
						[{ type: event.type, data: event.data }],
						{
							expectedSeq: event.seq - 1,
							actor: OPERATOR,
							tenant: TENANT,
						},
					);
			}
			const folded = foldRollout(
				rid(recording.rolloutId),
				store.events(ROLLOUT_LEDGER.stream(recording.rolloutId)),
			);
			expect(folded?.finished?.status, name).toBe(recording.status);
			const replayed = rig({ store });
			expect(
				(await replayed.orchestrator.get(rid(recording.rolloutId)))?.status,
				name,
			).toBe(recording.status);
		}
	});
});
