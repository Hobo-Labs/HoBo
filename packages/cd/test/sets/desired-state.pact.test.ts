// Provider verification of the desired-state boundary (promotion → DeltaLedger,
// reconcilers/feed → DesiredStateReader) against the consumer pact beside it.
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	CampManagement,
	DeltaRecordSchema,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { CD_STREAMS } from "../../src/events.js";
import type { DeltaId } from "../../src/ports.js";
import {
	createDesiredState,
	DesiredStateError,
	diffResolvedSets,
} from "../../src/sets/index.js";
import {
	camp,
	collect,
	createFakeArtifactStore,
	createFakeEventStore,
	ctxAt,
	resolvedFor,
	SHOP_V1,
	T0,
} from "./fakes.js";

type Interaction = {
	description: string;
	request: { method: string; body: Record<string, unknown> };
	response: {
		body: Record<string, unknown>;
		matchingRules?: Record<string, { match: string; regex: string }>;
	};
};

const pact: {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
} = JSON.parse(
	readFileSync(new URL("./desired-state.pact.json", import.meta.url), "utf8"),
);

function interaction(method: string): Interaction {
	const found = pact.interactions.find((i) => i.request.method === method);
	if (!found) throw new Error(`no ${method} interaction`);
	return found;
}

function at(body: unknown, path: string): unknown {
	return path
		.replace(/^\$\.body\./, "")
		.split(".")
		.reduce<unknown>(
			(value, key) => (value as Record<string, unknown> | undefined)?.[key],
			body,
		);
}

async function withOneSet() {
	const store = createFakeEventStore();
	const artifacts = createFakeArtifactStore();
	const desired = createDesiredState({
		store,
		artifacts,
		tenant: "acme",
		now: () => T0,
	});
	const resolved = resolvedFor("prod-aws", SHOP_V1);
	await desired.open(
		create(DeltaRecordSchema, {
			deltaId: "delta-1",
			campId: "prod-aws",
			intent: "promote",
			changes: diffResolvedSets(undefined, resolved),
		}),
		ctxAt(T0),
	);
	const applied = await desired.apply(
		{
			deltaId: "delta-1" as DeltaId,
			gateDecisionId: "gate-1",
			resolved,
			origin: SetOrigin.PROMOTION,
		},
		ctxAt(T0),
	);
	return { store, artifacts, desired, applied };
}

describe(`PACT ${pact.consumer.name} → ${pact.provider.name}`, () => {
	it("covers every interaction", () => {
		expect(pact.interactions.map((i) => i.request.method).sort()).toEqual([
			"APPLY",
			"CHANGES",
			"OPEN",
			"RESOLVED",
		]);
	});

	it("APPLY: opens and applies a Delta, storing a PACKAGE blob", async () => {
		const expected = interaction("APPLY").response;
		const { store, artifacts, applied } = await withOneSet();
		if (!applied.ok) throw new Error("refused");
		const set = applied.value;
		const actual = {
			ok: true,
			set: {
				schemaVersion: set.schemaVersion,
				campId: set.campId,
				origin: `SET_ORIGIN_${SetOrigin[set.origin]}`,
				gateDecisionId: set.gateDecisionId,
				predecessorSetId: set.predecessorSetId,
			},
			events: store.log.map((e) => e.event.type),
			stream: store.log[0]?.event.streamId,
			blob: {
				kind: `ARTIFACT_KIND_${ArtifactKind[artifacts.puts[0]?.kind ?? 0]}`,
				mediaType: artifacts.puts[0]?.mediaType,
			},
		};
		expect(actual).toEqual(expected.body);
		const wire = {
			set: {
				setId: set.setId,
				resolvedSetDigest: set.resolvedSetDigest,
				resolvedSetBytes: String(set.resolvedSetBytes),
			},
		};
		for (const [path, rule] of Object.entries(expected.matchingRules ?? {})) {
			expect(String(at(wire, path))).toMatch(new RegExp(rule.regex));
		}
	});

	it("CHANGES: frames by position carry management, observe fields and a verifiable resolved set", async () => {
		const expected = interaction("CHANGES").response.body;
		const { desired } = await withOneSet();
		const controller = new AbortController();
		const frames = await collect(
			desired.changes({
				campIds: [camp("prod-aws")],
				signal: controller.signal,
			}),
			1,
		);
		controller.abort();
		const first = frames[0];
		if (!first) throw new Error("no frame");
		const resolved = await desired.resolved(first.set);
		expect({
			frames: frames.map((f) => ({
				management: CampManagement[f.management],
				observeFields: f.observeFields,
				setOrigin: `SET_ORIGIN_${SetOrigin[f.set.origin]}`,
			})),
			resolved: {
				schemaVersion: resolved.schemaVersion,
				campId: resolved.campId,
				resources: resolved.plan.resources.map((r) => r.name),
			},
		}).toEqual(expected);
		expect(CD_STREAMS.campSpec("prod-aws")).toBe("cd-camp-prod-aws");
	});

	it("OPEN: a stale base is refused with a typed, remediable reason", async () => {
		const { request, response } = interaction("OPEN");
		const { desired } = await withOneSet();
		const outcome = await desired.open(
			create(DeltaRecordSchema, request.body as never),
			ctxAt(T0),
		);
		expect({
			ok: outcome.ok,
			code: outcome.ok ? undefined : outcome.reasons[0]?.code,
			hasRemediation:
				!outcome.ok && (outcome.reasons[0]?.remediation.length ?? 0) > 0,
		}).toEqual(response.body);
	});

	it("RESOLVED: a corrupted blob blocks with a reason", async () => {
		const expected = interaction("RESOLVED").response.body;
		const { desired, artifacts, applied } = await withOneSet();
		if (!applied.ok) throw new Error("refused");
		artifacts.corrupt(applied.value.resolvedSetDigest);
		const error = await desired
			.resolved(applied.value)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DesiredStateError);
		const typed = error as DesiredStateError;
		expect({
			error: typed.code,
			hasRemediation: typed.remediation.length > 0,
		}).toEqual(expected);
	});
});
