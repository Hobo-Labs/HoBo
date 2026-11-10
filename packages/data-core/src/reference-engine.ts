/**
 * The reference engine: a complete, deterministic, in-memory implementation
 * of the SPI.
 *
 * It exists for three reasons. It is the executable definition of what each
 * port means, so an engine author can read one small file instead of
 * inferring semantics from a suite. It lets the conformance kit test itself.
 * And it gives every always-on test a second engine to move data to and from
 * without a server. It is not a store anyone should keep data in.
 */
import {
	type CanonicalRecord,
	type DatasetSchema,
	schemaDigest,
} from "./canonical.js";
import { type DatasetDigest, DatasetDigestBuilder } from "./digest.js";
import {
	type ChangeEnvelope,
	envelopeOf,
	type Position,
	type RecordMutation,
} from "./envelope.js";
import { DataCoreError, FencedWriteError } from "./errors.js";
import {
	type CaptureOrdering,
	type DatasetScope,
	type EngineBinding,
	type EngineDeclaration,
	type FenceEnforcement,
	parseEngineDeclaration,
	type SnapshotConsistency,
	SPI_PORTS,
	type SpiPortName,
} from "./spi.js";
import { type TypeMappingAnnex, typeMappingToJson } from "./type-mapping.js";

// public-contract: capability profile id of the in-memory reference engine.
export const REFERENCE_ENGINE_PROFILE = "data.reference/v1";

/** Every canonical type, stored as-is: the reference engine is exact. */
export const REFERENCE_TYPE_MAPPING: TypeMappingAnnex = Object.freeze({
	engine: "reference",
	edges: Object.freeze(
		(
			[
				"bool",
				"int64",
				"float64",
				"decimal",
				"string",
				"bytes",
				"timestamp",
				"date",
				"uuid",
				"json",
				"encrypted",
			] as const
		).map((canonical) =>
			Object.freeze({
				canonical,
				native: "canonical",
				write: "exact" as const,
				read: "exact" as const,
				note: "",
			}),
		),
	),
});

export interface ReferenceEngineOptions {
	/** Engine id reported in the declaration. Defaults to `reference`. */
	readonly engine?: string;
	/** Ports to leave out, to model an engine that cannot provide them. */
	readonly omit?: readonly SpiPortName[];
}

interface StoredDataset {
	readonly schema: DatasetSchema;
	readonly rows: Map<
		string,
		{ tenant: string; key: string; record: CanonicalRecord }
	>;
	readonly journal: { seq: number; envelope: ChangeEnvelope }[];
	readonly watermarks: Map<string, Position>;
	readonly fences: Map<string, string>;
}

const SEPARATOR = "\u0000";

function slot(tenant: string, key: string): string {
	return `${tenant}${SEPARATOR}${key}`;
}

function inScope(scope: DatasetScope, tenant: string): boolean {
	return scope.tenant === "" || scope.tenant === tenant;
}

function declarationFor(
	engine: string,
	ports: readonly SpiPortName[],
): EngineDeclaration {
	const captureOrdering: CaptureOrdering = ports.includes("capture")
		? "global"
		: "none";
	const fenceEnforcement: FenceEnforcement = ports.includes("fence")
		? "entry-point"
		: "none";
	const snapshotConsistency: SnapshotConsistency = ports.includes("snapshot")
		? "fuzzy"
		: "none";
	return parseEngineDeclaration({
		engine,
		profile: REFERENCE_ENGINE_PROFILE,
		paradigm: "reference",
		ports: [...ports],
		captureOrdering,
		fenceEnforcement,
		snapshotConsistency,
		ddlTransactional: false,
		nativeProfiles: [],
		typeMapping: typeMappingToJson({ ...REFERENCE_TYPE_MAPPING, engine }),
		impedance: [],
	});
}

export function createReferenceEngine(
	options: ReferenceEngineOptions = {},
): EngineBinding {
	const engine = options.engine ?? "reference";
	const omit = options.omit ?? [];
	// The reference engine has no SQL surface, so it never offers `schema`.
	const ports = SPI_PORTS.filter(
		(port) => port !== "schema" && !omit.includes(port),
	);
	const datasets = new Map<string, StoredDataset>();
	const subscriptions = new Map<string, Position>();
	let sequence = 0;
	let fenceCounter = 0;

	const dataset = (name: string): StoredDataset => {
		const found = datasets.get(name);
		if (found === undefined) {
			throw new DataCoreError(
				"INVALID_RECORD",
				`dataset ${name} does not exist`,
				{
					detail: { dataset: name },
				},
			);
		}
		return found;
	};

	const assertWritable = (
		stored: StoredDataset,
		tenant: string,
		fenceToken: string | undefined,
	): void => {
		for (const scopeTenant of ["", tenant]) {
			const token = stored.fences.get(scopeTenant);
			if (token !== undefined && token !== fenceToken) {
				throw new FencedWriteError(stored.schema.name, tenant);
			}
		}
	};

	/** The one write path: every mutation is journaled as it lands. */
	const commit = (
		stored: StoredDataset,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): void => {
		for (const mutation of mutations) {
			assertWritable(stored, mutation.tenant, fenceToken);
		}
		for (const mutation of mutations) {
			const at = slot(mutation.tenant, mutation.key);
			if (mutation.op === "upsert" && mutation.record !== undefined) {
				stored.rows.set(at, {
					tenant: mutation.tenant,
					key: mutation.key,
					record: mutation.record,
				});
			} else {
				stored.rows.delete(at);
			}
			sequence += 1;
			stored.journal.push({
				seq: sequence,
				envelope: envelopeOf(stored.schema, mutation, String(sequence)),
			});
		}
	};

	const digestOfScope = (
		scope: DatasetScope,
		buckets: number,
	): DatasetDigest => {
		const builder = new DatasetDigestBuilder(
			scope.dataset,
			scope.tenant,
			buckets,
		);
		for (const row of dataset(scope.dataset).rows.values()) {
			if (inScope(scope, row.tenant))
				builder.add(row.tenant, row.key, row.record);
		}
		return builder.finish();
	};

	const binding: EngineBinding = {
		declaration: declarationFor(engine, ports),
		datasets: {
			ensureDataset(schema) {
				const existing = datasets.get(schema.name);
				if (existing !== undefined) {
					if (schemaDigest(existing.schema) !== schemaDigest(schema)) {
						throw new DataCoreError(
							"INVALID_DATASET_SCHEMA",
							`dataset ${schema.name} exists with a different schema`,
							{ detail: { dataset: schema.name } },
						);
					}
					return { dataset: schema.name, created: false };
				}
				datasets.set(schema.name, {
					schema,
					rows: new Map(),
					journal: [],
					watermarks: new Map(),
					fences: new Map(),
				});
				return { dataset: schema.name, created: true };
			},
			describeDataset(name) {
				return datasets.get(name)?.schema;
			},
		},
		records: {
			write(request) {
				const stored = dataset(request.dataset);
				commit(stored, request.mutations, request.fenceToken);
				return {
					position: String(sequence),
					applied: request.mutations.length,
				};
			},
			read(request) {
				return dataset(request.dataset).rows.get(
					slot(request.tenant, request.key),
				)?.record;
			},
		},
		...(ports.includes("snapshot")
			? {
					snapshot: {
						openSnapshot(request) {
							const stored = dataset(request.scope.dataset);
							// Keys are fixed at open; values are read per chunk. That
							// is a deliberately fuzzy scan — the executors must
							// converge anyway, and this keeps them honest about it.
							const keys = [...stored.rows.values()]
								.filter((row) => inScope(request.scope, row.tenant))
								.map((row) => slot(row.tenant, row.key))
								.sort();
							let offset = 0;
							return {
								next() {
									if (offset >= keys.length) return undefined;
									const chunk: RecordMutation[] = [];
									for (const at of keys.slice(
										offset,
										offset + request.chunkSize,
									)) {
										const row = stored.rows.get(at);
										if (row !== undefined) {
											chunk.push({
												tenant: row.tenant,
												key: row.key,
												op: "upsert",
												record: row.record,
											});
										}
									}
									offset += request.chunkSize;
									return chunk;
								},
								close() {},
							};
						},
					},
				}
			: undefined),
		...(ports.includes("capture")
			? {
					capture: {
						start(request) {
							const existing = subscriptions.get(request.subscription);
							if (existing !== undefined) return existing;
							dataset(request.scope.dataset);
							const position = String(sequence);
							subscriptions.set(request.subscription, position);
							return position;
						},
						read(request) {
							const stored = dataset(request.scope.dataset);
							const after = Number(request.after);
							const pending = stored.journal.filter(
								(entry) =>
									entry.seq > after &&
									inScope(request.scope, entry.envelope.tenant),
							);
							const page = pending.slice(0, request.limit);
							const caughtUp = pending.length <= request.limit;
							const last = page[page.length - 1];
							return {
								changes: page.map((entry) => entry.envelope),
								// Caught up means everything to the head was considered,
								// including changes outside this scope.
								position: caughtUp
									? String(Math.max(sequence, after))
									: String(last?.seq ?? after),
								caughtUp,
							};
						},
						acknowledge() {},
						stop(subscription) {
							subscriptions.delete(subscription);
						},
					},
				}
			: undefined),
		...(ports.includes("apply")
			? {
					apply: {
						apply(request) {
							const stored = dataset(request.dataset);
							commit(stored, request.changes, request.fenceToken);
							stored.watermarks.set(request.source, request.position);
							return { applied: request.changes.length };
						},
						watermark(request) {
							return dataset(request.dataset).watermarks.get(request.source);
						},
					},
				}
			: undefined),
		...(ports.includes("verify")
			? {
					verify: {
						digest(request) {
							return digestOfScope(request.scope, request.buckets);
						},
					},
				}
			: undefined),
		...(ports.includes("fence")
			? {
					fence: {
						raise(request) {
							const stored = dataset(request.scope.dataset);
							const existing = stored.fences.get(request.scope.tenant);
							if (existing !== undefined) return { fenceToken: existing };
							fenceCounter += 1;
							const fenceToken = `fence:${request.scope.dataset}:${request.scope.tenant}:${fenceCounter}`;
							stored.fences.set(request.scope.tenant, fenceToken);
							return { fenceToken };
						},
						release(request) {
							const stored = dataset(request.scope.dataset);
							const existing = stored.fences.get(request.scope.tenant);
							if (existing === undefined) return;
							if (existing !== request.fenceToken) {
								throw new DataCoreError(
									"FENCE_TOKEN_MISMATCH",
									"only the fence token holder may release a fence",
									{ detail: { dataset: request.scope.dataset } },
								);
							}
							stored.fences.delete(request.scope.tenant);
						},
						status(scope) {
							return {
								fenced: dataset(scope.dataset).fences.has(scope.tenant),
							};
						},
					},
				}
			: undefined),
		...(ports.includes("retire")
			? {
					retire: {
						retire(request) {
							const stored = dataset(request.scope.dataset);
							if (
								stored.fences.get(request.scope.tenant) !== request.fenceToken
							) {
								throw new DataCoreError(
									"RETIRE_REFUSED",
									"retire needs the raised fence's token; the store may still be authoritative",
									{ detail: { dataset: request.scope.dataset } },
								);
							}
							const current = digestOfScope(
								request.scope,
								request.expected.buckets.length,
							);
							if (
								current.count !== request.expected.count ||
								current.digest !== request.expected.digest
							) {
								throw new DataCoreError(
									"RETIRE_REFUSED",
									"the store no longer matches the verified digest",
									{ detail: { dataset: request.scope.dataset } },
								);
							}
							let removed = 0;
							for (const [at, row] of stored.rows) {
								if (inScope(request.scope, row.tenant)) {
									stored.rows.delete(at);
									removed += 1;
								}
							}
							return { removed };
						},
					},
				}
			: undefined),
		close() {},
	};
	return Object.freeze(binding);
}

/**
 * A view of a binding with some ports hidden, and a declaration that says so.
 * Used to prove what a pattern does when an engine lacks a port — a missing
 * reverse tail, for instance — without needing a second implementation.
 */
export function withoutPorts(
	binding: EngineBinding,
	hidden: readonly SpiPortName[],
): EngineBinding {
	const ports = binding.declaration.ports.filter(
		(port) => !hidden.includes(port),
	);
	const declaration: EngineDeclaration = Object.freeze({
		...binding.declaration,
		ports: Object.freeze(ports),
		captureOrdering: ports.includes("capture")
			? binding.declaration.captureOrdering
			: "none",
		fenceEnforcement: ports.includes("fence")
			? binding.declaration.fenceEnforcement
			: "none",
		snapshotConsistency: ports.includes("snapshot")
			? binding.declaration.snapshotConsistency
			: "none",
	});
	const keep = <K extends SpiPortName>(
		port: K,
	): EngineBinding[K] | undefined =>
		hidden.includes(port) ? undefined : binding[port];
	const snapshot = keep("snapshot");
	const capture = keep("capture");
	const apply = keep("apply");
	const verify = keep("verify");
	const fence = keep("fence");
	const retire = keep("retire");
	const schema = keep("schema");
	return Object.freeze({
		declaration,
		datasets: binding.datasets,
		records: binding.records,
		...(snapshot === undefined ? undefined : { snapshot }),
		...(capture === undefined ? undefined : { capture }),
		...(apply === undefined ? undefined : { apply }),
		...(verify === undefined ? undefined : { verify }),
		...(fence === undefined ? undefined : { fence }),
		...(retire === undefined ? undefined : { retire }),
		...(schema === undefined ? undefined : { schema }),
		close: () => binding.close(),
	});
}
