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
	decodeRecordKey,
	encodeRecordKey,
	schemaDigest,
} from "./canonical.js";
import { type DatasetDigest, DatasetDigestBuilder } from "./digest.js";
import {
	type ChangeEnvelope,
	envelopeOf,
	type Position,
	type RecordMutation,
} from "./envelope.js";
import {
	CapturePositionError,
	DataCoreError,
	FencedWriteError,
	StaleApplyError,
} from "./errors.js";
import { isJsonString, type JsonObject } from "./json.js";
import {
	type CaptureOrdering,
	type DatasetScope,
	type EngineBinding,
	type EngineDeclaration,
	type FenceEnforcement,
	type NativeTransferPort,
	type NativeTransferRef,
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

// public-contract: the reference engine's native migration profile; realizes both copy patterns.
export const REFERENCE_NATIVE_PROFILE = "migration.reference.direct/v1";

/** The patterns the reference engine's native profile realizes. */
const REFERENCE_NATIVE_PATTERNS = [
	"snapshot-and-tail",
	"offline-copy",
] as const;

/**
 * How two reference engines reach each other for a native transfer: the
 * in-memory stand-in for the network path and credential a real engine is
 * constructed with. Engines given the same link can transfer natively; the
 * ticket that crosses the port only names the origin, it never carries it.
 */
export interface ReferenceNativeLink {
	/**
	 * While stalled nothing moves: a copy that has not finished, a tail that
	 * lags. For proving what an executor does when the engine is slow.
	 */
	stall(stalled: boolean): void;
	/** Names of transfers either side still holds; empty once all were stopped. */
	open(): readonly string[];
}

interface LinkedSubscriber {
	/** Copy the scope once, then apply everything published since. */
	pull(): void;
}

interface LinkedPublication {
	readonly scope: DatasetScope;
	/** Head of the source's journal the target has applied through. */
	confirmed: number;
	subscriber: LinkedSubscriber | undefined;
}

interface LinkedOrigin {
	readonly publications: Map<string, LinkedPublication>;
	head(): number;
	rows(scope: DatasetScope): readonly RecordMutation[];
	changesAfter(scope: DatasetScope, after: number): readonly RecordMutation[];
}

interface LinkState {
	stalled: boolean;
	readonly origins: Map<string, LinkedOrigin>;
	readonly subscriptions: Set<string>;
}

const LINKS = new WeakMap<ReferenceNativeLink, LinkState>();
let originCounter = 0;

export function createReferenceNativeLink(): ReferenceNativeLink {
	const state: LinkState = {
		stalled: false,
		origins: new Map(),
		subscriptions: new Set(),
	};
	const link: ReferenceNativeLink = Object.freeze({
		stall(stalled: boolean): void {
			state.stalled = stalled;
		},
		open(): readonly string[] {
			const names = new Set(state.subscriptions);
			for (const origin of state.origins.values()) {
				for (const name of origin.publications.keys()) names.add(name);
			}
			return [...names].sort();
		},
	});
	LINKS.set(link, state);
	return link;
}

export interface ReferenceEngineOptions {
	/** Engine id reported in the declaration. Defaults to `reference`. */
	readonly engine?: string;
	/** Ports to leave out, to model an engine that cannot provide them. */
	readonly omit?: readonly SpiPortName[];
	/**
	 * Opt in to the native profile. The engine then declares
	 * `REFERENCE_NATIVE_PROFILE` and provides the `nativeTransfer` port, and
	 * can transfer natively with any engine given the same link.
	 */
	readonly native?: ReferenceNativeLink;
}

interface StoredDataset {
	readonly schema: DatasetSchema;
	readonly rows: Map<
		string,
		{ tenant: string; key: string; record: CanonicalRecord }
	>;
	/** `write` numbers the write a change landed in: a read never splits one. */
	readonly journal: { seq: number; write: number; envelope: ChangeEnvelope }[];
	readonly watermarks: Map<string, Position>;
	readonly fences: Map<string, string>;
}

const SEPARATOR = "\u0000";

function slot(tenant: string, key: string): string {
	return `${tenant}${SEPARATOR}${key}`;
}

/**
 * A reference position is a journal sequence number. Anything else was minted
 * by another engine, or by nobody: answering it with "nothing after that"
 * would look exactly like being caught up.
 */
function positionOf(position: Position, subscription = ""): number {
	if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(position)) {
		throw new CapturePositionError(
			subscription,
			"a capture position for the reference engine is a journal sequence number",
		);
	}
	return Number(position);
}

/** A capture subscription: the scope its name is bound to, and how far it acknowledged. */
interface ReferenceSubscription {
	readonly scope: DatasetScope;
	readonly start: Position;
	/** Everything at or before this was acknowledged; a read from before it is refused. */
	floor: number;
}

/**
 * A well-formed reference position past `head`: the journal is a sequence, so
 * any larger number is one this engine could mint later and has not yet.
 */
export function referencePositionPastHead(head: Position): Position {
	return String(positionOf(head) + 1_000_000);
}

function inScope(scope: DatasetScope, tenant: string): boolean {
	return scope.tenant === "" || scope.tenant === tenant;
}

function declarationFor(
	engine: string,
	ports: readonly SpiPortName[],
	native: boolean,
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
		nativeProfiles: native
			? REFERENCE_NATIVE_PATTERNS.map((pattern) => ({
					profile: REFERENCE_NATIVE_PROFILE,
					pattern,
				}))
			: [],
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
	const subscriptions = new Map<string, ReferenceSubscription>();
	let sequence = 0;
	let writes = 0;
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
		const refuse = (message: string): never => {
			throw new DataCoreError("INVALID_RECORD", message, {
				detail: { dataset: stored.schema.name, field: "key" },
			});
		};
		for (const mutation of mutations) {
			assertWritable(stored, mutation.tenant, fenceToken);
			if (mutation.op === "upsert") {
				if (mutation.record === undefined) {
					refuse("an upsert carries the record it writes");
				}
				// A record is stored where its own key says. A mutation that
				// names one key and carries the record of another would otherwise
				// sit under a key no other engine could find it by.
				else if (
					encodeRecordKey(stored.schema, mutation.record) !== mutation.key
				) {
					refuse("a mutation's key must be the key of its record");
				}
			} else if (
				// A delete names a key and nothing else, so the key has to be in
				// its one canonical spelling: any other names no record here, and
				// would silently delete nothing while another engine deleted one.
				encodeRecordKey(
					stored.schema,
					decodeRecordKey(stored.schema, mutation.key),
				) !== mutation.key
			) {
				refuse("a delete names a record by its canonical key");
			}
		}
		writes += 1;
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
				write: writes,
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

	const link =
		options.native === undefined ? undefined : LINKS.get(options.native);
	originCounter += 1;
	const originId = `reference-origin-${originCounter}`;
	const nativePublications = new Map<string, LinkedPublication>();
	const nativeSubscriptions = new Map<string, { readonly origin: string }>();
	/** Transfers this engine subscribes to and has been told to stop applying. */
	const nativePaused = new Set<string>();
	if (link !== undefined) {
		link.origins.set(originId, {
			publications: nativePublications,
			head: () => sequence,
			rows: (scope) =>
				[...dataset(scope.dataset).rows.values()]
					.filter((row) => inScope(scope, row.tenant))
					.map((row) => ({
						tenant: row.tenant,
						key: row.key,
						op: "upsert" as const,
						record: row.record,
					})),
			changesAfter: (scope, after) =>
				dataset(scope.dataset)
					.journal.filter(
						(entry) =>
							entry.seq > after && inScope(scope, entry.envelope.tenant),
					)
					.map((entry) => ({
						tenant: entry.envelope.tenant,
						key: entry.envelope.key,
						op: entry.envelope.op,
						...(entry.envelope.record === undefined
							? undefined
							: { record: entry.envelope.record }),
					})),
		});
	}

	const refused = (reason: string, message: string): DataCoreError =>
		new DataCoreError("NATIVE_TRANSFER_REFUSED", message, {
			detail: { engine, reason, profile: REFERENCE_NATIVE_PROFILE },
		});
	const lost = (ref: NativeTransferRef): DataCoreError =>
		new DataCoreError(
			"NATIVE_TRANSFER_LOST",
			`native transfer ${ref.transfer} was never opened here, or was stopped`,
			{ detail: { engine, transfer: ref.transfer } },
		);
	const assertProfile = (ref: NativeTransferRef): void => {
		if (ref.profile !== REFERENCE_NATIVE_PROFILE) {
			throw refused(
				"PROFILE_UNKNOWN",
				`the reference engine does not run ${ref.profile}`,
			);
		}
	};

	/**
	 * The native transfer: a direct copy from one reference engine's rows and
	 * journal into another's, reached through the link both were given. It
	 * moves when asked how far it has got, so an executor's waiting is real.
	 */
	const nativeTransfer = (state: LinkState): NativeTransferPort => ({
		profiles: Object.freeze([REFERENCE_NATIVE_PROFILE]),
		publish(ref): JsonObject {
			assertProfile(ref);
			dataset(ref.scope.dataset);
			if (!nativePublications.has(ref.transfer)) {
				nativePublications.set(ref.transfer, {
					scope: ref.scope,
					confirmed: sequence,
					subscriber: undefined,
				});
			}
			// The ticket names the origin; it does not carry a way to reach it.
			return {
				profile: REFERENCE_NATIVE_PROFILE,
				origin: originId,
				dataset: ref.scope.dataset,
				tenant: ref.scope.tenant,
			};
		},
		subscribe(request): void {
			assertProfile(request);
			if (nativeSubscriptions.has(request.transfer)) return;
			const { ticket, scope } = request;
			const origin = isJsonString(ticket.origin)
				? state.origins.get(ticket.origin)
				: undefined;
			const publication = origin?.publications.get(request.transfer);
			if (
				origin === undefined ||
				publication === undefined ||
				!isJsonString(ticket.origin)
			) {
				throw refused(
					"SOURCE_UNREACHABLE",
					"the ticket names a source this engine was given no link to",
				);
			}
			if (ticket.origin === originId) {
				throw refused(
					"SAME_STORE",
					"a native transfer cannot copy a store into itself",
				);
			}
			if (ticket.dataset !== scope.dataset || ticket.tenant !== scope.tenant) {
				throw refused(
					"SCOPE_MISMATCH",
					"a native transfer lands a scope under the same name it left; renaming a dataset or a tenant needs the hub",
				);
			}
			const stored = dataset(scope.dataset);
			if ([...stored.rows.values()].some((row) => inScope(scope, row.tenant))) {
				throw refused(
					"TARGET_NOT_EMPTY",
					"a native copy needs an empty target scope; it cannot merge into records already there",
				);
			}
			let copiedThrough: number | undefined;
			publication.subscriber = {
				pull(): void {
					if (state.stalled || nativePaused.has(request.transfer)) return;
					if (copiedThrough === undefined) {
						commit(stored, origin.rows(publication.scope), undefined);
					} else {
						commit(
							stored,
							origin.changesAfter(publication.scope, copiedThrough),
							undefined,
						);
					}
					copiedThrough = origin.head();
					publication.confirmed = copiedThrough;
				},
			};
			nativeSubscriptions.set(request.transfer, { origin: ticket.origin });
			state.subscriptions.add(request.transfer);
		},
		seeded(ref): boolean {
			const subscription = nativeSubscriptions.get(ref.transfer);
			const publication =
				subscription === undefined
					? undefined
					: state.origins
							.get(subscription.origin)
							?.publications.get(ref.transfer);
			if (publication?.subscriber === undefined) throw lost(ref);
			if (state.stalled || nativePaused.has(ref.transfer)) return false;
			publication.subscriber.pull();
			return true;
		},
		mark(ref): Position {
			if (!nativePublications.has(ref.transfer)) throw lost(ref);
			return String(sequence);
		},
		reached(request): boolean {
			const publication = nativePublications.get(request.transfer);
			if (publication === undefined) throw lost(request);
			publication.subscriber?.pull();
			return (
				publication.subscriber !== undefined &&
				publication.confirmed >= positionOf(request.mark)
			);
		},
		pause(ref): void {
			// Only a transfer this engine subscribes to has anything to pause.
			if (nativeSubscriptions.has(ref.transfer)) nativePaused.add(ref.transfer);
		},
		resume(ref): void {
			nativePaused.delete(ref.transfer);
		},
		stop(ref): void {
			// Both halves: whichever this engine holds for the transfer.
			nativePaused.delete(ref.transfer);
			const subscription = nativeSubscriptions.get(ref.transfer);
			if (subscription !== undefined) {
				const publication = state.origins
					.get(subscription.origin)
					?.publications.get(ref.transfer);
				if (publication !== undefined) publication.subscriber = undefined;
				subscriptions.delete(ref.transfer);
				state.subscriptions.delete(ref.transfer);
			}
			nativePublications.delete(ref.transfer);
		},
	});

	const binding: EngineBinding = {
		declaration: declarationFor(engine, ports, link !== undefined),
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
							if (existing !== undefined) {
								// A name is one reader of one scope. Answering its
								// position to a reader of another scope would start
								// that reader somewhere it never asked to be.
								if (
									existing.scope.dataset !== request.scope.dataset ||
									existing.scope.tenant !== request.scope.tenant
								) {
									throw new DataCoreError(
										"CAPTURE_SUBSCRIPTION_CONFLICT",
										`subscription ${request.subscription} is bound to another scope`,
										{ detail: { subscription: request.subscription } },
									);
								}
								return existing.start;
							}
							dataset(request.scope.dataset);
							const position = String(sequence);
							subscriptions.set(request.subscription, {
								scope: request.scope,
								start: position,
								floor: 0,
							});
							return position;
						},
						read(request) {
							const stored = dataset(request.scope.dataset);
							const after = positionOf(request.after, request.subscription);
							const floor = subscriptions.get(request.subscription)?.floor ?? 0;
							if (after > sequence || after < floor) {
								throw new CapturePositionError(
									request.subscription,
									after > sequence
										? "the position is past the head of the journal; this engine never minted it"
										: "changes before the acknowledged position were released and cannot be read again",
								);
							}
							const pending = stored.journal.filter(
								(entry) =>
									entry.seq > after &&
									inScope(request.scope, entry.envelope.tenant),
							);
							// Whole writes only: the first is always taken, however
							// large, and a later one only while it fits the limit.
							const page: typeof pending = [];
							let taken = 0;
							while (taken < pending.length) {
								const write = pending[taken]?.write;
								let end = taken;
								while (pending[end]?.write === write) end += 1;
								if (page.length > 0 && end > request.limit) break;
								for (const entry of pending.slice(taken, end)) page.push(entry);
								taken = end;
							}
							const caughtUp = taken >= pending.length;
							const last = page[page.length - 1];
							return {
								changes: page.map((entry) => entry.envelope),
								// Caught up means everything to the head was considered,
								// including changes outside this scope.
								position: caughtUp
									? String(sequence)
									: String(last?.seq ?? after),
								caughtUp,
							};
						},
						acknowledge(request) {
							const position = positionOf(
								request.position,
								request.subscription,
							);
							if (position > sequence) {
								throw new CapturePositionError(
									request.subscription,
									"a position past the head of the journal cannot be acknowledged; nothing was read there",
								);
							}
							const subscription = subscriptions.get(request.subscription);
							if (subscription !== undefined) {
								subscription.floor = Math.max(subscription.floor, position);
							}
						},
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
							// Compared and written with no await in between: this
							// is the reference engine's one transaction.
							if (
								request.expectedWatermark !== undefined &&
								(stored.watermarks.get(request.source) ?? null) !==
									request.expectedWatermark
							) {
								throw new StaleApplyError(request.dataset, request.source);
							}
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
							// Redelivery: the scope is already empty behind the
							// caller's own fence. There is nothing left to compare
							// and nothing to remove.
							if (current.count === 0) return { removed: 0 };
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
		...(link === undefined
			? undefined
			: { nativeTransfer: nativeTransfer(link) }),
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
		...(binding.nativeTransfer === undefined
			? undefined
			: { nativeTransfer: binding.nativeTransfer }),
		close: () => binding.close(),
	});
}
