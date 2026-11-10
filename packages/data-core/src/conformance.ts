/**
 * The engine conformance kit (ADR-0177 §9 of the design note).
 *
 * One suite, run against any `EngineBinding` through a harness that creates
 * fresh bindings. It proves the ports mean what the SPI says they mean, and
 * then proves the patterns built on them: zero loss under load, a single
 * write authority, resume at every phase boundary, a lossless soak, and a
 * rollback that cannot resurrect an erased subject.
 *
 * The fold is pessimistic on purpose. A case that fails is `fail`; a case
 * whose port the engine declares but whose check could not run is `not-run`,
 * which makes the outcome `unknown`; and `unknown` is as non-selectable as
 * `fail`. The only way to be selected is to have actually run the checks.
 */
import type { DataClassification } from "@hobo/core";
import {
	type CanonicalRecord,
	type DatasetSchema,
	encodeRecordKey,
	parseCanonicalRecord,
	parseDatasetSchema,
	schemaDigest,
} from "./canonical.js";
import {
	type CustodyPath,
	evaluateCustodyPath,
	type PolicyVerdict,
	parseCustodyPath,
} from "./custody.js";
import { compareDigests, DatasetDigestBuilder } from "./digest.js";
import {
	deleteMutation,
	type RecordMutation,
	upsertMutation,
} from "./envelope.js";
import { DataCoreError, FencedWriteError } from "./errors.js";
import {
	type CopyMigrationOptions,
	runOfflineCopy,
	runSnapshotAndTail,
} from "./executors/copy.js";
import {
	type InPlaceEvolvePlan,
	runInPlaceEvolve,
} from "./executors/in-place.js";
import type { MigrationRuntime } from "./executors/runtime.js";
import {
	createMemoryMigrationJournal,
	type MigrationJournal,
} from "./facts.js";
import { canonicalEncode, type JsonObject, type JsonValue } from "./json.js";
import type { MigrationPhase } from "./patterns.js";
import { withoutPorts } from "./reference-engine.js";
import type { ConformanceOutcome } from "./selector.js";
import {
	type Awaitable,
	assertBindingMatchesDeclaration,
	type EngineBinding,
	requirePort,
	type SpiPortName,
	scopeOf,
} from "./spi.js";

// public-contract: reference id of the engine conformance suite; recorded with every report.
export const ENGINE_CONFORMANCE_SUITE = "hobo.data-engine-conformance/v1";

export const CONFORMANCE_STATUSES = [
	"pass",
	"fail",
	"blocked",
	"not-run",
] as const;
export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number];

// domain-view: recorded result; wire form is EngineConformanceResult in data-models/data_core.proto.
export interface EngineConformanceResult {
	readonly caseId: string;
	readonly status: ConformanceStatus;
	/** Operator-facing detail. Never contains record payload or credentials. */
	readonly detail: string;
}

// domain-view: recorded report; wire form is EngineConformanceReport in data-models/data_core.proto.
export interface EngineConformanceReport {
	readonly suite: typeof ENGINE_CONFORMANCE_SUITE;
	readonly engine: string;
	readonly outcome: ConformanceOutcome;
	readonly results: readonly EngineConformanceResult[];
	/** Cases skipped because the engine does not declare the port. */
	readonly skipped: readonly string[];
	readonly checkedAt: string;
}

/**
 * Fold case results into one outcome. Any failure is `fail`; anything
 * unproven is `unknown`. Shared by every engine package so "passes
 * conformance" means the same thing everywhere.
 */
export function foldConformance(
	results: readonly EngineConformanceResult[],
): ConformanceOutcome {
	if (
		results.some(
			(result) => result.status === "fail" || result.status === "blocked",
		)
	) {
		return "fail";
	}
	return results.some((result) => result.status === "not-run")
		? "unknown"
		: "pass";
}

/** SQL an engine with a `schema` port supplies so in-place-evolve can be proven. */
export interface SchemaFixture {
	/** Statements that create and populate the starting table. */
	readonly setup: readonly string[];
	readonly plan: InPlaceEvolvePlan;
	/** A violations query that must return rows once the contract phase ran. */
	readonly provesContractApplied: string;
	/** A statement that must fail, to prove a failed phase rolls back. */
	readonly failingStatement: string;
}

export interface EngineHarness {
	/** A fresh, empty binding. `label` distinguishes several within one case. */
	create(label: string): Awaitable<EngineBinding>;
	dispose?(binding: EngineBinding): Awaitable<void>;
	readonly schemaFixture?: SchemaFixture;
}

export interface RunEngineConformanceInput {
	readonly engine: EngineHarness;
	/**
	 * The other side of the pattern cases. Defaults to `engine`, which proves a
	 * same-engine move; pass another engine's harness to prove a cross-engine one.
	 */
	readonly peer?: EngineHarness;
	/** Injected instant, RFC 3339. */
	readonly now: string;
	/** Restrict to these case ids; absent runs every case. */
	readonly only?: readonly string[];
}

interface CaseContext {
	readonly input: RunEngineConformanceInput;
	open(label: string): Promise<EngineBinding>;
	openPeer(label: string): Promise<EngineBinding>;
}

interface ConformanceCase {
	readonly id: string;
	/** Ports the engine under test must declare for the case to apply. */
	readonly requires: readonly SpiPortName[];
	/** Ports the peer must declare; a peer without them makes the case `not-run`. */
	readonly peerRequires?: readonly SpiPortName[];
	readonly dependsOn?: readonly string[];
	run(context: CaseContext): Promise<void>;
}

/** A failed expectation inside a case. Its message is the recorded detail. */
class Expectation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Expectation";
	}
}

function expect(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Expectation(message);
}

// ── fixtures ────────────────────────────────────────────────────────────────

// public-contract: dataset name every conformance case provisions; engines isolate by store, not by name.
export const CONFORMANCE_DATASET = "hobo_conformance_orders";

/**
 * One field of every canonical type. An engine that cannot carry a type says
 * so in its annex and the kit leaves that field out of the schema it uses.
 */
const ALL_FIELDS: readonly JsonObject[] = Object.freeze([
	{ name: "id", type: "string", nullable: false },
	{ name: "qty", type: "int64", nullable: false },
	{ name: "price", type: "decimal", nullable: false },
	{ name: "weight", type: "float64", nullable: false },
	{ name: "active", type: "bool", nullable: false },
	{ name: "note", type: "string", nullable: true },
	{ name: "blob", type: "bytes", nullable: false },
	{ name: "placed_at", type: "timestamp", nullable: false },
	{ name: "due", type: "date", nullable: false },
	{ name: "ref", type: "uuid", nullable: false },
	{ name: "attrs", type: "json", nullable: false },
	{ name: "card", type: "encrypted", nullable: true },
]);

/** The conformance schema restricted to types every given engine can carry. */
export function conformanceSchema(
	bindings: readonly EngineBinding[],
): DatasetSchema {
	const fields = ALL_FIELDS.filter((field) =>
		bindings.every((binding) =>
			binding.declaration.typeMapping.edges.some(
				(edge) =>
					edge.canonical === field.type &&
					edge.write !== "lossy" &&
					edge.read !== "lossy",
			),
		),
	);
	return parseDatasetSchema({
		name: CONFORMANCE_DATASET,
		version: 1,
		keyFields: ["id"],
		fields: [...fields],
	});
}

/** The sentinel appears in a payload and must never appear in evidence. */
const PAYLOAD_SENTINEL = "hobo-conformance-payload-sentinel";

const RAW_RECORD: JsonObject = Object.freeze({
	qty: "9007199254740993",
	price: "001234.5600",
	weight: 0.1,
	active: true,
	note: `quote ' "double" and ünïcödé — ${PAYLOAD_SENTINEL}`,
	blob: "AAECA/8=",
	placed_at: "2026-01-02T05:04:05.678+02:00",
	due: "2026-02-28",
	ref: "0F8FAD5B-D9CB-469F-A165-70867728950E",
	attrs: { z: [1, 2, { nested: null }], a: "b" },
	card: {
		alg: "AES-256-GCM",
		keyRef: "key://subject/1",
		ciphertext: "3q2+7w==",
	},
});

function recordFor(
	schema: DatasetSchema,
	id: string,
	overrides: JsonObject = {},
): CanonicalRecord {
	const raw: { [key: string]: JsonValue } = {};
	raw.id = id;
	for (const field of schema.fields) {
		if (field.name === "id") continue;
		raw[field.name] = overrides[field.name] ?? RAW_RECORD[field.name] ?? null;
	}
	return parseCanonicalRecord(schema, raw);
}

function upsert(
	schema: DatasetSchema,
	tenant: string,
	id: string,
	overrides: JsonObject = {},
): RecordMutation {
	const record = recordFor(schema, id, overrides);
	return upsertMutation(tenant, encodeRecordKey(schema, record), record);
}

function keyOf(schema: DatasetSchema, id: string): string {
	return encodeRecordKey(schema, recordFor(schema, id));
}

async function write(
	binding: EngineBinding,
	mutations: readonly RecordMutation[],
	fenceToken?: string,
): Promise<void> {
	await binding.records.write({
		dataset: CONFORMANCE_DATASET,
		mutations,
		...(fenceToken === undefined ? undefined : { fenceToken }),
	});
}

async function refuses(
	action: () => Awaitable<void>,
): Promise<Error | undefined> {
	try {
		await action();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	return undefined;
}

const ALLOWING_PATH: CustodyPath = parseCustodyPath({
	points: [
		{ id: "source", role: "source", region: "eu-west-1", protections: [] },
		{ id: "target", role: "target", region: "eu-west-1", protections: [] },
	],
});

function allow(now: string): () => PolicyVerdict {
	const classification: DataClassification = "public";
	return () =>
		evaluateCustodyPath({
			path: ALLOWING_PATH,
			policy: { classification },
			now,
		});
}

function runtime(
	id: string,
	now: string,
	journal: MigrationJournal,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: id,
		journal,
		clock: () => now,
		policy: allow(now),
		...extra,
	};
}

async function digestsEqual(
	source: EngineBinding,
	target: EngineBinding,
	tenant = "",
): Promise<boolean> {
	const scope = scopeOf(CONFORMANCE_DATASET, tenant);
	const left = await requirePort(source, "verify").digest({
		scope,
		buckets: 8,
	});
	const right = await requirePort(target, "verify").digest({
		scope,
		buckets: 8,
	});
	return compareDigests(left, right).equal;
}

const COPY_SOURCE: readonly SpiPortName[] = [
	"snapshot",
	"capture",
	"verify",
	"fence",
	"retire",
];
const COPY_TARGET: readonly SpiPortName[] = ["apply", "verify"];

interface Pair {
	readonly source: EngineBinding;
	readonly target: EngineBinding;
	readonly schema: DatasetSchema;
}

async function seededPair(context: CaseContext, rows: number): Promise<Pair> {
	const source = await context.open("source");
	const target = await context.openPeer("target");
	const schema = conformanceSchema([source, target]);
	await source.datasets.ensureDataset(schema);
	const mutations: RecordMutation[] = [];
	for (let index = 0; index < rows; index += 1) {
		mutations.push(
			upsert(schema, "", `order-${index}`, { qty: String(index) }),
		);
	}
	await write(source, mutations);
	return { source, target, schema };
}

function copyOptions(
	pair: Pair,
	run: MigrationRuntime,
	extra: Partial<CopyMigrationOptions> = {},
): CopyMigrationOptions {
	return {
		runtime: run,
		source: pair.source,
		target: pair.target,
		schema: pair.schema,
		scope: scopeOf(CONFORMANCE_DATASET),
		chunkSize: 7,
		tailBatch: 5,
		buckets: 8,
		flipAuthority: () => {},
		...extra,
	};
}

// ── cases ───────────────────────────────────────────────────────────────────

const CASES: readonly ConformanceCase[] = Object.freeze([
	{
		id: "declaration.matches-binding",
		requires: [],
		async run(context) {
			assertBindingMatchesDeclaration(await context.open("a"));
		},
	},
	{
		id: "datasets.ensure-idempotent",
		requires: ["datasets"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			const first = await binding.datasets.ensureDataset(schema);
			const second = await binding.datasets.ensureDataset(schema);
			expect(first.created, "the first ensureDataset must report created");
			expect(!second.created, "a second ensureDataset must be a no-op");
			const described = await binding.datasets.describeDataset(schema.name);
			expect(
				described !== undefined &&
					schemaDigest(described) === schemaDigest(schema),
				"describeDataset must return the schema that was ensured",
			);
			expect(
				(await binding.datasets.describeDataset("hobo_conformance_absent")) ===
					undefined,
				"an absent dataset describes as undefined",
			);
		},
	},
	{
		id: "records.round-trip-canonical",
		requires: ["records"],
		dependsOn: ["datasets.ensure-idempotent"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const mutation = upsert(schema, "", "order-1");
			await write(binding, [mutation]);
			const read = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key: mutation.key,
			});
			expect(read !== undefined, "a written record must be readable");
			expect(
				canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
				"a record must read back in the same canonical form it was written in",
			);
			await write(binding, [deleteMutation("", mutation.key)]);
			expect(
				(await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				})) === undefined,
				"a deleted record must read as undefined",
			);
		},
	},
	{
		id: "records.tenants-are-isolated",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1", { qty: "1" }),
				upsert(schema, "tenant-b", "order-1", { qty: "2" }),
			]);
			const key = keyOf(schema, "order-1");
			const a = await binding.records.read({
				dataset: schema.name,
				tenant: "tenant-a",
				key,
			});
			const b = await binding.records.read({
				dataset: schema.name,
				tenant: "tenant-b",
				key,
			});
			expect(
				a?.qty === "1" && b?.qty === "2",
				"the same key in two tenants is two records",
			);
		},
	},
	{
		id: "mapping.constrained-never-silent",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			// Values at the edge of what an engine may store. Each must either
			// round-trip exactly or be refused; storing it altered is the failure.
			const probes: readonly JsonObject[] = [
				{ placed_at: "2026-01-02T03:04:05.678901Z" },
				{ price: "1234567890123456789012345678901234567890.123456789" },
				{ qty: "-9223372036854775808" },
				{ weight: 1.7976931348623157e308 },
				// U+0000 in text, and JSON keys some engines reserve.
				{ note: "nul \u0000 inside" },
				{ attrs: { $reserved: 1, "dotted.key": 2 } },
			];
			for (const [index, probe] of probes.entries()) {
				const field = Object.keys(probe)[0] ?? "";
				if (!schema.fields.some((entry) => entry.name === field)) continue;
				const mutation = upsert(schema, "", `probe-${index}`, probe);
				const refused = await refuses(() => write(binding, [mutation]));
				if (refused !== undefined) continue;
				const read = await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				});
				expect(
					read !== undefined &&
						canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
					`${field} was stored altered instead of being refused`,
				);
			}
		},
	},
	{
		id: "apply.idempotent-with-watermark",
		requires: ["apply", "verify"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const apply = requirePort(binding, "apply");
			const verify = requirePort(binding, "verify");
			const changes = [
				upsert(schema, "", "order-1", { qty: "1" }),
				upsert(schema, "", "order-2", { qty: "2" }),
				upsert(schema, "", "order-1", { qty: "3" }),
				deleteMutation("", keyOf(schema, "order-2")),
			];
			const scope = scopeOf(schema.name);
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) ===
					undefined,
				"a source with no applied batch has no watermark",
			);
			await apply.apply({
				dataset: schema.name,
				changes,
				source: "s",
				position: "41",
			});
			const once = await verify.digest({ scope, buckets: 8 });
			await apply.apply({
				dataset: schema.name,
				changes,
				source: "s",
				position: "41",
			});
			const twice = await verify.digest({ scope, buckets: 8 });
			expect(once.count === 1, "the batch leaves exactly one record");
			expect(
				compareDigests(once, twice).equal,
				"re-applying a batch must change nothing",
			);
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) === "41",
				"apply must record the batch position as the watermark",
			);
			await apply.apply({
				dataset: schema.name,
				changes: [],
				source: "s",
				position: "57",
			});
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) === "57",
				"an empty batch still advances the watermark",
			);
		},
	},
	{
		id: "verify.digest-is-engine-independent",
		requires: ["verify"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const expected = new DatasetDigestBuilder(schema.name, "", 8);
			const mutations: RecordMutation[] = [];
			for (let index = 0; index < 25; index += 1) {
				const tenant = index % 2 === 0 ? "tenant-a" : "tenant-b";
				const mutation = upsert(schema, tenant, `order-${index}`, {
					qty: String(index),
				});
				mutations.push(mutation);
				if (mutation.record !== undefined)
					expected.add(tenant, mutation.key, mutation.record);
			}
			await write(binding, mutations);
			const digest = await requirePort(binding, "verify").digest({
				scope: scopeOf(schema.name),
				buckets: 8,
			});
			expect(
				compareDigests(expected.finish(), digest).equal,
				"the engine's digest must equal the canonical digest of the same records",
			);
			const scoped = await requirePort(binding, "verify").digest({
				scope: scopeOf(schema.name, "tenant-a"),
				buckets: 8,
			});
			expect(
				scoped.count === 13,
				"a tenant-scoped digest counts only that tenant",
			);
			expect(
				!JSON.stringify(digest).includes(PAYLOAD_SENTINEL),
				"a digest must carry no record payload",
			);
		},
	},
	{
		id: "snapshot.returns-the-scope",
		requires: ["snapshot"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const mutations: RecordMutation[] = [];
			for (let index = 0; index < 23; index += 1) {
				mutations.push(
					upsert(
						schema,
						index < 20 ? "tenant-a" : "tenant-b",
						`order-${index}`,
					),
				);
			}
			await write(binding, mutations);
			const cursor = await requirePort(binding, "snapshot").openSnapshot({
				scope: scopeOf(schema.name, "tenant-a"),
				chunkSize: 6,
			});
			const seen = new Set<string>();
			let chunks = 0;
			for (;;) {
				const chunk = await cursor.next();
				if (chunk === undefined) break;
				chunks += 1;
				for (const mutation of chunk) {
					expect(mutation.op === "upsert", "a snapshot yields upserts");
					expect(
						mutation.tenant === "tenant-a",
						"a scoped snapshot stays in its tenant",
					);
					seen.add(mutation.key);
				}
			}
			await cursor.close();
			expect(
				seen.size === 20,
				"a snapshot returns every record in scope exactly once",
			);
			expect(chunks >= 4, "a snapshot honours its chunk size");
		},
	},
	{
		id: "capture.ordered-and-resumable",
		requires: ["capture"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name);
			await write(binding, [upsert(schema, "", "before", { qty: "0" })]);
			const start = await capture.start({ scope, subscription: "sub_a" });
			await write(binding, [upsert(schema, "", "order-1", { qty: "1" })]);
			await write(binding, [upsert(schema, "", "order-1", { qty: "2" })]);
			await write(binding, [deleteMutation("", keyOf(schema, "order-1"))]);
			await write(binding, [upsert(schema, "", "order-2", { qty: "3" })]);
			expect(
				(await capture.start({ scope, subscription: "sub_a" })) === start,
				"starting an existing subscription returns its original position",
			);
			const first = await capture.read({
				scope,
				subscription: "sub_a",
				after: start,
				limit: 2,
			});
			expect(first.changes.length === 2, "read honours its limit");
			expect(!first.caughtUp, "a partial read is not caught up");
			const rest = await capture.read({
				scope,
				subscription: "sub_a",
				after: first.position,
				limit: 10,
			});
			expect(rest.caughtUp, "reading to the end is caught up");
			const all = [...first.changes, ...rest.changes];
			expect(
				all.every((change) => change.key !== keyOf(schema, "before")),
				"changes before the subscription started are not captured",
			);
			const ops = all.map(
				(change) => `${change.op}:${change.record?.qty ?? "-"}`,
			);
			expect(
				ops.join(",") === "upsert:1,upsert:2,delete:-,upsert:3",
				`changes must arrive in commit order, got ${ops.join(",")}`,
			);
			const again = await capture.read({
				scope,
				subscription: "sub_a",
				after: start,
				limit: 10,
			});
			expect(
				again.changes.length === 4,
				"read does not consume; an unacknowledged read repeats",
			);
			await capture.acknowledge({
				subscription: "sub_a",
				position: rest.position,
			});
			const empty = await capture.read({
				scope,
				subscription: "sub_a",
				after: rest.position,
				limit: 10,
			});
			expect(
				empty.changes.length === 0 && empty.caughtUp,
				"nothing remains after the head",
			);
			await capture.stop("sub_a");
		},
	},
	{
		id: "capture.tenant-scope",
		requires: ["capture"],
		dependsOn: ["capture.ordered-and-resumable"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name, "tenant-a");
			const start = await capture.start({ scope, subscription: "sub_t" });
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-b", "order-2"),
				upsert(schema, "tenant-a", "order-3"),
			]);
			const batch = await capture.read({
				scope,
				subscription: "sub_t",
				after: start,
				limit: 10,
			});
			expect(
				batch.changes.length === 2 &&
					batch.changes.every((change) => change.tenant === "tenant-a"),
				"a tenant-scoped capture returns only that tenant's changes",
			);
			await capture.stop("sub_t");
		},
	},
	{
		id: "fence.single-write-authority",
		requires: ["fence"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const scope = scopeOf(schema.name, "tenant-a");
			const grant = await fence.raise({ scope, reason: "conformance" });
			const again = await fence.raise({ scope, reason: "conformance" });
			expect(
				grant.fenceToken === again.fenceToken,
				"raising a raised fence returns its token",
			);
			expect((await fence.status(scope)).fenced, "status reports the fence");
			const refused = await refuses(() =>
				write(binding, [upsert(schema, "tenant-a", "order-1")]),
			);
			expect(
				refused instanceof FencedWriteError,
				"a write to a fenced scope must be refused with FencedWriteError",
			);
			await write(binding, [upsert(schema, "tenant-b", "order-2")]);
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-3")],
				grant.fenceToken,
			);
			const wrong = await refuses(() =>
				fence.release({ scope, fenceToken: `${grant.fenceToken}-not` }),
			);
			expect(wrong !== undefined, "only the token holder may release a fence");
			await fence.release({ scope, fenceToken: grant.fenceToken });
			expect(!(await fence.status(scope)).fenced, "a released fence is gone");
			await write(binding, [upsert(schema, "tenant-a", "order-4")]);
		},
	},
	{
		id: "fence.raise-waits-for-in-flight-writes",
		requires: ["fence", "verify"],
		dependsOn: ["fence.single-write-authority"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const scope = scopeOf(schema.name);
			// Writes are in flight when the fence is raised. Each must either
			// land before `raise` returns or be refused — none may land after.
			// Each outcome is captured as it settles — the error a refused write
			// threw, or nothing — so a refusal is never an unhandled rejection.
			const writes = Array.from({ length: 24 }, (_, index) =>
				refuses(() => write(binding, [upsert(schema, "", `racing-${index}`)])),
			);
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			const verify = requirePort(binding, "verify");
			const atRaise = await verify.digest({ scope, buckets: 8 });
			const outcomes = await Promise.all(writes);
			const landed = outcomes.filter((outcome) => outcome === undefined).length;
			for (const outcome of outcomes) {
				expect(
					outcome === undefined || outcome instanceof FencedWriteError,
					"a write racing the fence either lands or is refused with FencedWriteError",
				);
			}
			const afterwards = await verify.digest({ scope, buckets: 8 });
			expect(
				compareDigests(atRaise, afterwards).equal,
				"no write may land after raise has returned",
			);
			expect(
				afterwards.count === landed,
				"every write reported as accepted is present, and no refused write is",
			);
			await requirePort(binding, "fence").release({
				scope,
				fenceToken: grant.fenceToken,
			});
		},
	},
	{
		id: "retire.refused-unless-proven",
		requires: ["retire", "fence", "verify"],
		dependsOn: [
			"fence.single-write-authority",
			"verify.digest-is-engine-independent",
		],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-a", "order-2"),
				upsert(schema, "tenant-b", "order-3"),
			]);
			const scope = scopeOf(schema.name, "tenant-a");
			const retire = requirePort(binding, "retire");
			const verify = requirePort(binding, "verify");
			const digest = await verify.digest({ scope, buckets: 8 });
			const unfenced = await refuses(async () => {
				await retire.retire({ scope, fenceToken: "none", expected: digest });
			});
			expect(
				unfenced !== undefined,
				"retire without a raised fence must be refused",
			);
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-9")],
				grant.fenceToken,
			);
			const stale = await refuses(async () => {
				await retire.retire({
					scope,
					fenceToken: grant.fenceToken,
					expected: digest,
				});
			});
			expect(stale !== undefined, "retire with a stale digest must be refused");
			const fresh = await verify.digest({ scope, buckets: 8 });
			const receipt = await retire.retire({
				scope,
				fenceToken: grant.fenceToken,
				expected: fresh,
			});
			expect(receipt.removed === 3, "retire removes exactly the scope");
			const remaining = await verify.digest({
				scope: scopeOf(schema.name),
				buckets: 8,
			});
			expect(
				remaining.count === 1,
				"another tenant's records survive a scoped retire",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.zero-loss-under-load",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"apply.idempotent-with-watermark",
			"capture.ordered-and-resumable",
			"snapshot.returns-the-scope",
			"fence.single-write-authority",
			"retire.refused-unless-proven",
		],
		async run(context) {
			const pair = await seededPair(context, 40);
			let flipped = false;
			// Writes keep arriving between every phase: updates, inserts, deletes.
			const load = async (phase: MigrationPhase): Promise<void> => {
				if (flipped) return;
				await write(pair.source, [
					upsert(pair.schema, "", "order-1", { note: `after ${phase}` }),
					upsert(pair.schema, "", `order-new-${phase}`, { qty: "7" }),
					deleteMutation("", keyOf(pair.schema, `order-${phase.length}`)),
				]);
			};
			const result = await runSnapshotAndTail(
				copyOptions(
					pair,
					runtime(
						"zero-loss",
						context.input.now,
						createMemoryMigrationJournal(),
						{
							afterPhase: load,
							pauseAfter: "fence-and-flip",
						},
					),
					{
						flipAuthority: () => {
							flipped = true;
						},
					},
				),
			);
			expect(result.status === "held", "the run pauses in the soak window");
			expect(flipped, "write authority moved exactly once");
			expect(
				await digestsEqual(pair.source, pair.target),
				"source and target must digest equal at the fence position",
			);
			const refused = await refuses(() =>
				write(pair.source, [upsert(pair.schema, "", "late-write")]),
			);
			expect(
				refused instanceof FencedWriteError,
				"after the flip the old authority must refuse writes",
			);
			expect(
				!JSON.stringify(result.facts).includes(PAYLOAD_SENTINEL),
				"migration facts must carry no record payload",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.resumes-at-every-boundary",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const boundaries: readonly MigrationPhase[] = [
				"gate",
				"prepare",
				"seed",
				"converge",
				"verify",
				"shift-reads",
				"fence-and-flip",
				"soak",
			];
			for (const boundary of boundaries) {
				const pair = await seededPair(context, 12);
				const journal = createMemoryMigrationJournal();
				let crashed = false;
				const crashing = runtime(
					`resume-${boundary}`,
					context.input.now,
					journal,
					{
						afterPhase: (phase) => {
							if (phase === boundary && !crashed) {
								crashed = true;
								throw new Error(`injected crash after ${phase}`);
							}
						},
					},
				);
				const first = await refuses(async () => {
					await runSnapshotAndTail(copyOptions(pair, crashing));
				});
				expect(
					first !== undefined,
					`the injected crash after ${boundary} must surface`,
				);
				const resumed = await runSnapshotAndTail(
					copyOptions(
						pair,
						runtime(`resume-${boundary}`, context.input.now, journal),
					),
				);
				expect(
					resumed.status === "completed",
					`a run crashed after ${boundary} must resume to completion, got ${resumed.status}`,
				);
				const after = await requirePort(pair.target, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(
					after.count === 12,
					`resume after ${boundary} must not lose or duplicate records`,
				);
				const emptied = await requirePort(pair.source, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(emptied.count === 0, "a completed migration retires the source");
			}
		},
	},
	{
		id: "pattern.snapshot-and-tail.lossless-soak-rollback",
		requires: [...COPY_SOURCE, "apply"],
		peerRequires: [...COPY_TARGET, "capture"],
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const pair = await seededPair(context, 10);
			const journal = createMemoryMigrationJournal();
			const held = await runSnapshotAndTail(
				copyOptions(pair, runtime("soak", context.input.now, journal), {
					soakDecision: () => "hold",
				}),
			);
			expect(
				held.status === "held" && held.rollback === "lossless",
				"soak holds losslessly",
			);
			// The target is now the authority; these writes exist only there.
			await write(pair.target, [
				upsert(pair.schema, "", "written-after-flip", { qty: "99" }),
				deleteMutation("", keyOf(pair.schema, "order-3")),
			]);
			const directions: string[] = [];
			const rolled = await runSnapshotAndTail(
				copyOptions(pair, runtime("soak", context.input.now, journal), {
					soakDecision: () => "rollback",
					flipAuthority: (flip) => {
						directions.push(flip.direction);
					},
				}),
			);
			expect(rolled.status === "rolled-back", "the run rolls back from soak");
			expect(
				directions.join(",") === "to-source",
				"authority returns to the source once",
			);
			expect(
				await digestsEqual(pair.source, pair.target),
				"a rollback under a reverse tail loses no acknowledged write",
			);
			const kept = await pair.source.records.read({
				dataset: CONFORMANCE_DATASET,
				tenant: "",
				key: keyOf(pair.schema, "written-after-flip"),
			});
			expect(
				kept?.qty === "99",
				"a write made after the flip survives the rollback",
			);
			await write(pair.source, [upsert(pair.schema, "", "after-rollback")]);
		},
	},
	{
		id: "pattern.snapshot-and-tail.rollback-never-resurrects",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const seeded = await seededPair(context, 6);
			// No reverse tail: the source goes stale at the flip, so a rollback
			// is to-snapshot. An erasure made meanwhile must still hold.
			const pair: Pair = {
				...seeded,
				target: withoutPorts(seeded.target, ["capture"]),
			};
			const journal = createMemoryMigrationJournal();
			const held = await runSnapshotAndTail(
				copyOptions(pair, runtime("erase", context.input.now, journal), {
					soakDecision: () => "hold",
				}),
			);
			expect(
				held.status === "held" && held.rollback === "to-snapshot",
				"without a reverse tail the soak posture is to-snapshot, and says so",
			);
			const erasedKey = keyOf(pair.schema, "order-2");
			await write(pair.target, [deleteMutation("", erasedKey)]);
			const rolled = await runSnapshotAndTail(
				copyOptions(pair, runtime("erase", context.input.now, journal), {
					soakDecision: () => "rollback",
					erasures: { since: () => [deleteMutation("", erasedKey)] },
				}),
			);
			expect(rolled.status === "rolled-back", "the run rolls back");
			expect(
				(await pair.source.records.read({
					dataset: CONFORMANCE_DATASET,
					tenant: "",
					key: erasedKey,
				})) === undefined,
				"a rollback must not resurrect an erased subject",
			);
			expect(
				(rolled.reason ?? "").includes("lost"),
				"a lossy rollback states its loss instead of claiming none",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.tenant-move",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"pattern.snapshot-and-tail.zero-loss-under-load",
			"capture.tenant-scope",
		],
		async run(context) {
			const source = await context.open("pooled");
			const target = await context.openPeer("silo");
			const schema = conformanceSchema([source, target]);
			await source.datasets.ensureDataset(schema);
			await write(source, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-b", "order-2"),
				upsert(schema, "tenant-a", "order-3"),
			]);
			const result = await runSnapshotAndTail(
				copyOptions(
					{ source, target, schema },
					runtime(
						"tenant-move",
						context.input.now,
						createMemoryMigrationJournal(),
					),
					{ scope: scopeOf(CONFORMANCE_DATASET, "tenant-a") },
				),
			);
			expect(result.status === "completed", "a pooled-to-silo move completes");
			const silo = await requirePort(target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(silo.count === 2, "the silo holds exactly the moved tenant");
			const pooled = await requirePort(source, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(
				pooled.count === 1,
				"the pooled store keeps the other tenant, untouched",
			);
			await write(source, [upsert(schema, "tenant-b", "order-9")]);
		},
	},
	{
		id: "pattern.offline-copy.exact",
		requires: ["snapshot", "verify", "fence", "retire"],
		peerRequires: COPY_TARGET,
		dependsOn: ["snapshot.returns-the-scope", "retire.refused-unless-proven"],
		async run(context) {
			const pair = await seededPair(context, 15);
			const result = await runOfflineCopy(
				copyOptions(
					pair,
					runtime("offline", context.input.now, createMemoryMigrationJournal()),
				),
			);
			expect(result.status === "completed", "an offline copy completes");
			const target = await requirePort(pair.target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(target.count === 15, "every record arrived");
			const source = await requirePort(pair.source, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(source.count === 0, "the source is retired after a verified copy");
		},
	},
	{
		id: "pattern.in-place-evolve.gated-and-restorable",
		requires: ["schema"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			if (fixture === undefined)
				throw new NotRun("the harness supplies no schema fixture");
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			const blocked = await runInPlaceEvolve({
				port,
				plan: fixture.plan,
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: ["legacy-consumer"],
					verifiedAt: context.input.now,
				}),
			});
			expect(
				blocked.status === "contract-blocked" && blocked.dualWindowOpen,
				"a consumer on the old shape blocks the destructive phase and keeps the dual window open",
			);
			expect(
				(await port.verify(fixture.provesContractApplied)).length === 0,
				"a blocked contract phase must not have run",
			);
		},
	},
	{
		id: "pattern.in-place-evolve.failure-restores",
		requires: ["schema"],
		dependsOn: ["pattern.in-place-evolve.gated-and-restorable"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			if (fixture === undefined)
				throw new NotRun("the harness supplies no schema fixture");
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			let replayed = 0;
			const failed = await runInPlaceEvolve({
				port,
				plan: { ...fixture.plan, contract: [fixture.failingStatement] },
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: [],
					verifiedAt: context.input.now,
				}),
				replayErasures: () => {
					replayed += 1;
					return 0;
				},
			});
			expect(
				failed.status === "rolled-back",
				"a failed phase restores the snapshot",
			);
			expect(
				replayed === 1,
				"a restore re-applies erasures recorded since the snapshot",
			);
			const completed = await runInPlaceEvolve({
				port,
				plan: fixture.plan,
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: [],
					verifiedAt: context.input.now,
				}),
			});
			expect(
				completed.status === "completed",
				"the same plan then completes from the restored state",
			);
			expect(
				(await port.verify(fixture.provesContractApplied)).length > 0,
				"the contract phase ran",
			);
		},
	},
]);

/** Thrown by a case that applies but cannot be exercised. */
class NotRun extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotRun";
	}
}

export const ENGINE_CONFORMANCE_CASE_IDS: readonly string[] = Object.freeze(
	CASES.map((entry) => entry.id),
);

function declares(
	binding: EngineBinding,
	ports: readonly SpiPortName[],
): boolean {
	return ports.every((port) => binding.declaration.ports.includes(port));
}

/**
 * Run the suite. A case whose ports the engine does not declare is skipped —
 * skipping is not forgiveness, the pattern that needs the port simply becomes
 * ineligible at selection. A case that applies but could not run is `not-run`.
 */
export async function runEngineConformance(
	input: RunEngineConformanceInput,
): Promise<EngineConformanceReport> {
	const probe = await input.engine.create("probe");
	const peerHarness = input.peer ?? input.engine;
	const peerProbe =
		input.peer === undefined ? probe : await peerHarness.create("peer-probe");
	const engine = probe.declaration.engine;
	const results: EngineConformanceResult[] = [];
	const skipped: string[] = [];
	const failed = new Set<string>();
	const unproven = new Set<string>();
	const unknownIds = (input.only ?? []).filter(
		(id) => !ENGINE_CONFORMANCE_CASE_IDS.includes(id),
	);
	if (unknownIds.length > 0) {
		throw new DataCoreError(
			"CONFORMANCE_SUITE_INVALID",
			`unknown case ${unknownIds.join(", ")}`,
			{
				detail: { cases: unknownIds.join(",") },
			},
		);
	}
	try {
		for (const testCase of CASES) {
			if (input.only !== undefined && !input.only.includes(testCase.id))
				continue;
			if (!declares(probe, testCase.requires)) {
				skipped.push(testCase.id);
				continue;
			}
			const dependencies = (testCase.dependsOn ?? []).filter(
				(id) => input.only === undefined || input.only.includes(id),
			);
			const failedDependency = dependencies.find((id) => failed.has(id));
			if (failedDependency !== undefined) {
				failed.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "blocked",
					detail: `dependency ${failedDependency} failed`,
				});
				continue;
			}
			const unprovenDependency = dependencies.find((id) => unproven.has(id));
			if (unprovenDependency !== undefined) {
				unproven.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "not-run",
					detail: `dependency ${unprovenDependency} was not run`,
				});
				continue;
			}
			if (!declares(peerProbe, testCase.peerRequires ?? [])) {
				unproven.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "not-run",
					detail: `peer ${peerProbe.declaration.engine} lacks ${(testCase.peerRequires ?? []).join(", ")}`,
				});
				continue;
			}
			const opened: { binding: EngineBinding; harness: EngineHarness }[] = [];
			let counter = 0;
			const context: CaseContext = {
				input,
				async open(label) {
					counter += 1;
					const binding = await input.engine.create(
						`${testCase.id}:${label}:${counter}`,
					);
					opened.push({ binding, harness: input.engine });
					return binding;
				},
				async openPeer(label) {
					counter += 1;
					const binding = await peerHarness.create(
						`${testCase.id}:${label}:${counter}`,
					);
					opened.push({ binding, harness: peerHarness });
					return binding;
				},
			};
			try {
				await testCase.run(context);
				results.push({ caseId: testCase.id, status: "pass", detail: "ok" });
			} catch (error) {
				if (error instanceof NotRun) {
					unproven.add(testCase.id);
					results.push({
						caseId: testCase.id,
						status: "not-run",
						detail: error.message,
					});
				} else {
					failed.add(testCase.id);
					results.push({
						caseId: testCase.id,
						status: "fail",
						// An expectation's message is ours and safe to record. Anything
						// else may carry a connection string, so only its class is kept.
						detail:
							error instanceof Expectation
								? error.message
								: error instanceof DataCoreError
									? `${error.name}: ${error.code}`
									: error instanceof Error
										? `threw ${error.name}`
										: "threw a non-Error value",
					});
				}
			} finally {
				for (const { binding, harness } of opened) {
					try {
						await binding.close();
						await harness.dispose?.(binding);
					} catch {
						// Cleanup is best-effort; a case result is already recorded.
					}
				}
			}
		}
	} finally {
		await probe.close();
		await input.engine.dispose?.(probe);
		if (peerProbe !== probe) {
			await peerProbe.close();
			await peerHarness.dispose?.(peerProbe);
		}
	}
	return Object.freeze({
		suite: ENGINE_CONFORMANCE_SUITE,
		engine,
		outcome: foldConformance(results),
		results: Object.freeze(results.map((result) => Object.freeze(result))),
		skipped: Object.freeze(skipped),
		checkedAt: input.now,
	});
}
