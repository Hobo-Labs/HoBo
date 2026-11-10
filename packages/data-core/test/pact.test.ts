// The two PACT contracts in contracts/pacts, replayed against the real code.
// A contract nobody executes is a comment; every interaction here is run and
// its response compared with the recorded one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
	type Authority,
	type ChangeKind,
	CUSTODY_ROLES,
	createReferenceEngine,
	createReferenceNativeLink,
	DataCoreError,
	type DatasetSchema,
	envelopeToJson,
	evaluateCustodyPath,
	type JsonObject,
	type JsonValue,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	type RecordMutation,
	type RollbackPosture,
	requirePort,
	scopeOf,
	selectMigrationPattern,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = "2026-11-10T00:00:00.000Z";

interface Interaction {
	readonly description: string;
	readonly providerState: string;
	readonly request: { readonly path: string; readonly body: JsonObject };
	readonly response: { readonly status: number; readonly body: JsonObject };
}

function loadPact(name: string): readonly Interaction[] {
	const text = readFileSync(
		path.join(here, "..", "contracts", "pacts", name),
		"utf8",
	);
	// SAFETY: the pact file is a JSON document checked in beside this test.
	const pact = JSON.parse(text) as { interactions: Interaction[] };
	assert.ok(pact.interactions.length > 0);
	return pact.interactions;
}

const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

function mutations(raw: JsonValue | undefined): RecordMutation[] {
	// SAFETY: pact bodies list mutations in the wire form the contract records.
	return (
		raw as {
			tenant: string;
			key: string;
			op: "upsert" | "delete";
			record?: JsonObject;
		}[]
	).map((entry) =>
		entry.op === "upsert"
			? {
					tenant: entry.tenant,
					key: entry.key,
					op: "upsert",
					record: parseCanonicalRecord(ORDERS, entry.record),
				}
			: { tenant: entry.tenant, key: entry.key, op: "delete" },
	);
}

describe("pact: migration selector", () => {
	const verdict = evaluateCustodyPath({
		path: parseCustodyPath({
			// One point per role: the selector refuses a pattern that creates a
			// copy the path does not name, and these interactions are about the
			// other gates.
			points: CUSTODY_ROLES.map((role) => ({
				id: role,
				role,
				region: "eu-west-1",
				protections: [],
				...(role === "source" || role === "target" || role === "event-log"
					? undefined
					: { retainUntil: "2026-11-17T00:00:00.000Z" }),
			})),
		}),
		policy: { classification: "public" },
		now: NOW,
	});

	for (const interaction of loadPact("migration-selector.pact.json")) {
		test(interaction.description, () => {
			const body = interaction.request.body;
			const engines = [body.source, body.target].filter(
				(name): name is string => name !== undefined && name !== null,
			);
			// SAFETY: pact bodies carry the constraint and estimate records as recorded.
			const constraints = body.constraints as {
				maxWriteFreezeMs: number;
				requiredRollback: RollbackPosture;
			};
			// SAFETY: pact bodies carry the constraint and estimate records as recorded.
			const estimates = body.estimates as { flipMs?: number; copyMs?: number };
			const decision = selectMigrationPattern({
				// SAFETY: the pact records a member of the closed authority union.
				authority: body.authority as Authority,
				// SAFETY: the pact records a member of the closed change union.
				change: body.change as ChangeKind,
				...(body.source === undefined
					? undefined
					: {
							source: createReferenceEngine({ engine: String(body.source) })
								.declaration,
						}),
				...(body.target === undefined
					? undefined
					: {
							target: createReferenceEngine({ engine: String(body.target) })
								.declaration,
						}),
				schema: ORDERS,
				constraints,
				estimates,
				verdict,
				evidence: engines.map((engine) => ({
					engine,
					outcome: "pass",
					checkedAt: NOW,
				})),
				now: NOW,
				evidenceMaxAgeMs: 86_400_000,
			});
			const rejected: { [pattern: string]: string[] } = {};
			for (const candidate of decision.candidates) {
				if (!candidate.eligible) {
					rejected[candidate.pattern] = candidate.reasons.map(
						(reason) => reason.code,
					);
				}
			}
			const selected = decision.selected;
			assert.deepEqual(
				{
					selected:
						selected === undefined
							? null
							: {
									pattern: selected.pattern,
									realization: selected.realization,
									writeFreeze: selected.writeFreeze,
									rollbackInSoak: selected.rollbackInSoak,
								},
					rejected,
				},
				interaction.response.body,
			);
			assert.equal(
				interaction.response.status,
				selected === undefined ? 422 : 200,
			);
		});
	}
});

describe("pact: engine SPI", () => {
	const [fenced, captured, applied, digested, published, subscribed, stale] =
		loadPact("engine-spi.pact.json");

	test(fenced?.description ?? "fenced write", async () => {
		assert.ok(fenced);
		const engine = createReferenceEngine();
		await engine.datasets.ensureDataset(ORDERS);
		await requirePort(engine, "fence").raise({
			scope: scopeOf("orders", "acme"),
			reason: "pact",
		});
		let refusal: JsonObject = {};
		try {
			await engine.records.write({
				dataset: "orders",
				mutations: mutations(fenced.request.body.mutations),
			});
		} catch (error) {
			assert.ok(error instanceof DataCoreError);
			refusal = { error: { code: error.code, ...error.detail } };
		}
		assert.deepEqual(refusal, fenced.response.body);
		assert.equal(fenced.response.status, 409);
	});

	test(captured?.description ?? "capture read", async () => {
		assert.ok(captured);
		const engine = createReferenceEngine();
		await engine.datasets.ensureDataset(ORDERS);
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		await capture.start({ scope, subscription: "sub" });
		const write = (raw: JsonObject[]) =>
			engine.records.write({ dataset: "orders", mutations: mutations(raw) });
		await write([
			{
				tenant: "",
				key: '["o-1"]',
				op: "upsert",
				record: { id: "o-1", total: "10" },
			},
		]);
		await write([
			{
				tenant: "",
				key: '["o-1"]',
				op: "upsert",
				record: { id: "o-1", total: "12.50" },
			},
		]);
		await write([{ tenant: "", key: '["o-1"]', op: "delete" }]);
		const read = () =>
			capture.read({
				scope,
				subscription: "sub",
				after: String(captured.request.body.after),
				limit: Number(captured.request.body.limit),
			});
		const batch = await read();
		const view = {
			changes: batch.changes.map((change) => envelopeToJson(change)),
			position: batch.position,
			caughtUp: batch.caughtUp,
		};
		assert.deepEqual(view, captured.response.body);
		// Reading does not consume: the same read repeats.
		assert.equal((await read()).changes.length, 3);
	});

	test(applied?.description ?? "apply", async () => {
		assert.ok(applied);
		const engine = createReferenceEngine();
		await engine.datasets.ensureDataset(ORDERS);
		const apply = requirePort(engine, "apply");
		const receipt = await apply.apply({
			dataset: "orders",
			changes: mutations(applied.request.body.changes),
			source: String(applied.request.body.source),
			position: String(applied.request.body.position),
		});
		assert.deepEqual(
			{
				applied: receipt.applied,
				watermark: await apply.watermark({
					dataset: "orders",
					source: String(applied.request.body.source),
				}),
			},
			applied.response.body,
		);
	});

	test(stale?.description ?? "stale apply", async () => {
		assert.ok(applied);
		assert.ok(stale);
		const engine = createReferenceEngine();
		await engine.datasets.ensureDataset(ORDERS);
		const apply = requirePort(engine, "apply");
		// The provider state: the earlier interaction, applied.
		await apply.apply({
			dataset: "orders",
			changes: mutations(applied.request.body.changes),
			source: String(applied.request.body.source),
			position: String(applied.request.body.position),
		});
		const source = String(stale.request.body.source);
		let refusal: JsonObject = {};
		try {
			await apply.apply({
				dataset: "orders",
				changes: mutations(stale.request.body.changes),
				source,
				position: String(stale.request.body.position),
				expectedWatermark: String(stale.request.body.expectedWatermark),
			});
		} catch (error) {
			assert.ok(error instanceof DataCoreError);
			refusal = { error: { code: error.code, ...error.detail } };
		}
		const kept = await engine.records.read({
			dataset: "orders",
			tenant: "",
			key: '["o-9"]',
		});
		assert.deepEqual(
			{
				...refusal,
				watermark:
					(await apply.watermark({ dataset: "orders", source })) ?? null,
				total: kept?.total ?? null,
			},
			stale.response.body,
		);
		assert.equal(stale.response.status, 409);
	});

	test(digested?.description ?? "digest", async () => {
		assert.ok(digested);
		const engine = createReferenceEngine();
		await engine.datasets.ensureDataset(ORDERS);
		await engine.records.write({
			dataset: "orders",
			mutations: mutations([
				{
					tenant: "",
					key: '["o-9"]',
					op: "upsert",
					record: { id: "o-9", total: "1" },
				},
			]),
		});
		const digest = await requirePort(engine, "verify").digest({
			scope: scopeOf("orders", String(digested.request.body.tenant)),
			buckets: Number(digested.request.body.buckets),
		});
		assert.deepEqual(
			{
				contract: digest.contract,
				dataset: digest.dataset,
				tenant: digest.tenant,
				count: digest.count,
				keys: Object.keys(digest).sort(),
			},
			digested.response.body,
		);
		assert.ok(
			!JSON.stringify(digest).includes("o-9"),
			"no record payload in a digest",
		);
	});
	const transferOf = (requestPath: string): string =>
		requestPath.split("/")[4] ?? "";

	test(published?.description ?? "native publish", async () => {
		assert.ok(published);
		const engine = createReferenceEngine({
			native: createReferenceNativeLink(),
		});
		await engine.datasets.ensureDataset(ORDERS);
		await engine.records.write({
			dataset: "orders",
			mutations: mutations([
				{
					tenant: "",
					key: '["o-9"]',
					op: "upsert",
					record: { id: "o-9", total: "1" },
				},
			]),
		});
		const ticket = await engine.nativeTransfer?.publish({
			profile: String(published.request.body.profile),
			transfer: transferOf(published.request.path),
			scope: scopeOf("orders", String(published.request.body.tenant)),
		});
		assert.ok(ticket);
		// The origin is an opaque name minted per engine; its presence is the
		// contract, its value is not.
		const { origin: _origin, ...stable } = ticket;
		assert.deepEqual(
			{ ticket: stable, keys: Object.keys(ticket).sort() },
			published.response.body,
		);
		assert.ok(!JSON.stringify(ticket).includes("o-9"), "no record in a ticket");
	});

	test(subscribed?.description ?? "native subscribe", async () => {
		assert.ok(subscribed);
		const link = createReferenceNativeLink();
		const source = createReferenceEngine({ native: link });
		const target = createReferenceEngine({ native: link });
		const row: JsonObject[] = [
			{
				tenant: "",
				key: '["o-9"]',
				op: "upsert",
				record: { id: "o-9", total: "1" },
			},
		];
		for (const engine of [source, target]) {
			await engine.datasets.ensureDataset(ORDERS);
			await engine.records.write({
				dataset: "orders",
				mutations: mutations(row),
			});
		}
		const ref = {
			profile: String(subscribed.request.body.profile),
			transfer: transferOf(subscribed.request.path),
			scope: scopeOf("orders", String(subscribed.request.body.tenant)),
		};
		const ticket = await source.nativeTransfer?.publish(ref);
		assert.ok(ticket);
		let refusal: JsonObject = {};
		try {
			await target.nativeTransfer?.subscribe({ ...ref, ticket });
		} catch (error) {
			assert.ok(error instanceof DataCoreError);
			refusal = {
				error: {
					code: error.code,
					reason: error.detail.reason ?? "",
					profile: error.detail.profile ?? "",
				},
			};
		}
		assert.deepEqual(refusal, subscribed.response.body);
		assert.equal(subscribed.response.status, 409);
	});
});
