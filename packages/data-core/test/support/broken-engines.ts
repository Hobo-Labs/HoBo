// Deliberately broken engines: the kit's own regression suite.
//
// Each variant is a real reference engine with exactly one port made to
// misbehave in a way a real engine has, or plausibly could. The self-test
// runs the kit against every one and requires it to fail — and to fail in the
// case written to catch that defect. A kit that passes a variant here has a
// hole, whatever else it proves.
import {
	type CanonicalRecord,
	type ChangeEnvelope,
	canonicalEncode,
	createReferenceEngine,
	createReferenceNativeLink,
	DataCoreError,
	DatasetDigestBuilder,
	type DatasetScope,
	deleteMutation,
	type EngineBinding,
	type EngineHarness,
	envelopeOf,
	FencedWriteError,
	type JsonValue,
	type RecordMutation,
	referencePositionPastHead,
	requirePort,
	scopeOf,
} from "../../src/index.js";

export interface BrokenVariant {
	readonly name: string;
	/** The defect, as one sentence. */
	readonly defect: string;
	/** The case that must be the first to fail. */
	readonly caughtBy: string;
	readonly harness: EngineHarness;
}

type Break = (inner: EngineBinding) => EngineBinding;

function variant(
	name: string,
	defect: string,
	caughtBy: string,
	broken: Break,
): BrokenVariant {
	return {
		name,
		defect,
		caughtBy,
		harness: {
			create: () => broken(createReferenceEngine()),
			positionPastHead: referencePositionPastHead,
		},
	};
}

/** The tokens of every fence that covers these mutations, when fences are up. */
async function coveringTokens(
	inner: EngineBinding,
	dataset: string,
	mutations: readonly RecordMutation[],
): Promise<readonly string[]> {
	const fence = requirePort(inner, "fence");
	const tokens: string[] = [];
	for (const tenant of new Set([
		"",
		...mutations.map((entry) => entry.tenant),
	])) {
		const scope = scopeOf(dataset, tenant);
		if ((await fence.status(scope)).fenced) {
			// Raising a raised fence answers its token.
			tokens.push((await fence.raise({ scope, reason: "broken" })).fenceToken);
		}
	}
	return tokens;
}

/** Top-level values of a record, rewritten. */
function mangled(
	record: CanonicalRecord,
	swap: (value: JsonValue) => JsonValue,
): CanonicalRecord {
	return Object.fromEntries(
		Object.entries(record).map(([name, value]) => [name, swap(value)]),
	);
}

function mangling(swap: (value: JsonValue) => JsonValue): Break {
	const rewrite = (mutations: readonly RecordMutation[]): RecordMutation[] =>
		mutations.map((mutation) =>
			mutation.record === undefined
				? mutation
				: { ...mutation, record: mangled(mutation.record, swap) },
		);
	return (inner) => {
		const apply = requirePort(inner, "apply");
		return {
			...inner,
			records: {
				write: (request) =>
					inner.records.write({
						...request,
						mutations: rewrite(request.mutations),
					}),
				read: (request) => inner.records.read(request),
			},
			apply: {
				apply: (request) =>
					apply.apply({ ...request, changes: rewrite(request.changes) }),
				watermark: (request) => apply.watermark(request),
			},
		};
	};
}

/** Every row of a scope, through the engine's own snapshot port. */
async function rowsOf(
	inner: EngineBinding,
	scope: DatasetScope,
): Promise<readonly RecordMutation[]> {
	const cursor = await requirePort(inner, "snapshot").openSnapshot({
		scope,
		chunkSize: 1000,
	});
	const rows: RecordMutation[] = [];
	for (;;) {
		const chunk = await cursor.next();
		if (chunk === undefined) break;
		rows.push(...chunk);
	}
	return rows;
}

/** A digest computed over each record as `view` shows it. */
function digesting(view: (record: CanonicalRecord) => CanonicalRecord): Break {
	return (inner) => ({
		...inner,
		verify: {
			async digest(request) {
				const builder = new DatasetDigestBuilder(
					request.scope.dataset,
					request.scope.tenant,
					request.buckets,
				);
				for (const row of await rowsOf(inner, request.scope)) {
					if (row.record !== undefined) {
						builder.add(row.tenant, row.key, view(row.record));
					}
				}
				return builder.finish();
			},
		},
	});
}

const isEmptyObject = (value: JsonValue): boolean =>
	value !== null &&
	!Array.isArray(value) &&
	canonicalEncode(value) === canonicalEncode({});

export const BROKEN_VARIANTS: readonly BrokenVariant[] = [
	// ── fence semantics ───────────────────────────────────────────────────────
	variant(
		"fence-not-spanning",
		"a dataset-wide fence does not stop a tenant-scoped write",
		"fence.dataset-wide-covers-tenants",
		(inner) => ({
			...inner,
			records: {
				async write(request) {
					try {
						return await inner.records.write(request);
					} catch (cause) {
						const tenanted = request.mutations.every(
							(entry) => entry.tenant !== "",
						);
						if (!(cause instanceof FencedWriteError) || !tenanted) throw cause;
						const fence = requirePort(inner, "fence");
						const whole = scopeOf(request.dataset);
						if (!(await fence.status(whole)).fenced) throw cause;
						const grant = await fence.raise({ scope: whole, reason: "broken" });
						return inner.records.write({
							...request,
							fenceToken: grant.fenceToken,
						});
					}
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	variant(
		"any-token",
		"a write presenting any token at all is let through a fence",
		"fence.wrong-token-is-refused",
		(inner) => ({
			...inner,
			records: {
				async write(request) {
					try {
						return await inner.records.write(request);
					} catch (cause) {
						if (
							!(cause instanceof FencedWriteError) ||
							request.fenceToken === undefined
						) {
							throw cause;
						}
						const tokens = await coveringTokens(
							inner,
							request.dataset,
							request.mutations,
						);
						const token = tokens[0];
						if (tokens.length !== 1 || token === undefined) throw cause;
						return inner.records.write({ ...request, fenceToken: token });
					}
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	variant(
		"apply-bypasses-fence",
		"the apply port lands changes in a fenced scope without the token",
		"fence.apply-honours-the-fence",
		(inner) => {
			const apply = requirePort(inner, "apply");
			return {
				...inner,
				apply: {
					async apply(request) {
						try {
							return await apply.apply(request);
						} catch (cause) {
							if (!(cause instanceof FencedWriteError)) throw cause;
							const tokens = await coveringTokens(
								inner,
								request.dataset,
								request.changes,
							);
							const token = tokens[0];
							if (tokens.length !== 1 || token === undefined) throw cause;
							return apply.apply({ ...request, fenceToken: token });
						}
					},
					watermark: (request) => apply.watermark(request),
				},
			};
		},
	),
	variant(
		"retire-any-token",
		"retire accepts any token once some fence is up on the scope",
		"retire.foreign-token-is-refused",
		(inner) => {
			const retire = requirePort(inner, "retire");
			const fence = requirePort(inner, "fence");
			return {
				...inner,
				retire: {
					async retire(request) {
						if (!(await fence.status(request.scope)).fenced) {
							return retire.retire(request);
						}
						const grant = await fence.raise({
							scope: request.scope,
							reason: "broken",
						});
						return retire.retire({ ...request, fenceToken: grant.fenceToken });
					},
				},
			};
		},
	),
	variant(
		"fence-token-reused",
		"a fence raised after a release hands out the token of the one before",
		"fence.re-raise-mints-a-new-token",
		(inner) => {
			// One public token per scope, for ever; translated to whatever the
			// engine really minted for the fence that is up now.
			const fence = requirePort(inner, "fence");
			const retire = requirePort(inner, "retire");
			const apply = requirePort(inner, "apply");
			const publicToken = (scope: DatasetScope): string =>
				`reused:${scope.dataset}:${scope.tenant}`;
			const real = new Map<string, string>();
			const translate = (token: string | undefined): string | undefined =>
				token === undefined ? undefined : (real.get(token) ?? token);
			const through = <T extends { readonly fenceToken?: string }>(
				request: T,
			): T => {
				const token = translate(request.fenceToken);
				return token === undefined
					? request
					: { ...request, fenceToken: token };
			};
			return {
				...inner,
				records: {
					write: (request) => inner.records.write(through(request)),
					read: (request) => inner.records.read(request),
				},
				apply: {
					apply: (request) => apply.apply(through(request)),
					watermark: (request) => apply.watermark(request),
				},
				fence: {
					async raise(request) {
						const grant = await fence.raise(request);
						real.set(publicToken(request.scope), grant.fenceToken);
						return { fenceToken: publicToken(request.scope) };
					},
					release: (request) => fence.release(through(request)),
					status: (scope) => fence.status(scope),
				},
				retire: { retire: (request) => retire.retire(through(request)) },
			};
		},
	),
	// ── values ────────────────────────────────────────────────────────────────
	variant(
		"null-as-empty",
		"a null is stored as an empty string",
		"records.null-and-empty-are-distinct",
		mangling((value) => (value === null ? "" : value)),
	),
	variant(
		"empty-as-null",
		"an empty string is stored as null",
		"records.null-and-empty-are-distinct",
		mangling((value) => (value === "" ? null : value)),
	),
	variant(
		"empty-object-as-empty-array",
		"an empty object is stored as an empty array",
		"records.null-and-empty-are-distinct",
		mangling((value) => (isEmptyObject(value) ? [] : value)),
	),
	variant(
		"digest-conflates-null-and-empty",
		"the digest treats a null and an empty string as the same value",
		"records.null-and-empty-are-distinct",
		digesting((record) =>
			mangled(record, (value) => (value === "" ? null : value)),
		),
	),
	variant(
		"digest-ignores-a-field",
		"the digest leaves one field out",
		"verify.digest-is-engine-independent",
		digesting((record) =>
			Object.hasOwn(record, "note") ? { ...record, note: null } : record,
		),
	),
	// ── keys and sizes ────────────────────────────────────────────────────────
	variant(
		"uppercase-uuid-is-a-second-row",
		"an uppercase uuid key is stored as its own row beside the lowercase one",
		"records.keys-are-canonical",
		(inner) => ({
			...inner,
			records: {
				write(request) {
					const mutations = request.mutations.map((mutation) => {
						const record = mutation.record;
						if (record === undefined) return mutation;
						const own = canonicalEncode(
							Object.keys(record)
								.filter((name) => name === "ref")
								.map((name) => record[name] ?? null),
						);
						// Differs from the record's key only by letter case.
						if (
							own === mutation.key ||
							own.toLowerCase() !== mutation.key.toLowerCase()
						) {
							return mutation;
						}
						return {
							...mutation,
							record: { ...record, ref: String(record.ref).toUpperCase() },
						};
					});
					return inner.records.write({ ...request, mutations });
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	variant(
		"non-canonical-delete-ignored",
		"a delete naming a key in a non-canonical spelling silently deletes nothing",
		"records.keys-are-canonical",
		(inner) => ({
			...inner,
			records: {
				async write(request) {
					try {
						return await inner.records.write(request);
					} catch (cause) {
						const deletes = request.mutations.every(
							(entry) => entry.op === "delete",
						);
						if (
							!deletes ||
							!(cause instanceof DataCoreError) ||
							cause.code !== "INVALID_RECORD"
						) {
							throw cause;
						}
						return { applied: 0 };
					}
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	{
		name: "declared-size-bound-not-enforced",
		defect: "the declaration states a record bound the engine does not enforce",
		caughtBy: "records.oversize-record-refuses-the-batch",
		harness: {
			create: () => bounded(createReferenceEngine(), false),
			positionPastHead: referencePositionPastHead,
		},
	},
	// ── capture ───────────────────────────────────────────────────────────────
	variant(
		"capture-drops-a-delete",
		"capture leaves deletes out",
		"capture.ordered-and-resumable",
		(inner) => {
			const capture = requirePort(inner, "capture");
			return {
				...inner,
				capture: {
					...capture,
					async read(request) {
						const batch = await capture.read(request);
						return {
							...batch,
							changes: batch.changes.filter((change) => change.op !== "delete"),
						};
					},
				},
			};
		},
	),
	variant(
		"capture-splits-a-write",
		"a read cuts one write in two at its limit",
		"capture.write-is-read-whole",
		(inner) => {
			const capture = requirePort(inner, "capture");
			return {
				...inner,
				capture: {
					...capture,
					async read(request) {
						const batch = await capture.read({ ...request, limit: 1_000_000 });
						if (batch.changes.length <= request.limit) return batch;
						const changes = batch.changes.slice(0, request.limit);
						return {
							changes,
							position: changes[changes.length - 1]?.position ?? request.after,
							caughtUp: false,
						};
					},
				},
			};
		},
	),
	variant(
		"acknowledge-accepts-anything",
		"acknowledge takes any position and releases nothing",
		"capture.acknowledged-positions-are-final",
		(inner) => {
			const capture = requirePort(inner, "capture");
			return { ...inner, capture: { ...capture, acknowledge() {} } };
		},
	),
	variant(
		"acknowledge-past-the-head",
		"acknowledge accepts a position past the head of the log",
		"capture.acknowledged-positions-are-final",
		(inner) => {
			const capture = requirePort(inner, "capture");
			return {
				...inner,
				capture: {
					...capture,
					async acknowledge(request) {
						try {
							await capture.acknowledge(request);
						} catch (cause) {
							// Garbage is still refused; a number past the head is not.
							if (!/^[0-9]+$/u.test(request.position)) throw cause;
						}
					},
				},
			};
		},
	),
	variant(
		"subscription-name-shared-across-scopes",
		"a subscription name answers its first scope's position to every scope",
		"capture.subscription-name-is-bound-to-its-scope",
		(inner) => {
			const capture = requirePort(inner, "capture");
			const started = new Map<string, string>();
			return {
				...inner,
				capture: {
					...capture,
					async start(request) {
						const known = started.get(request.subscription);
						if (known !== undefined) return known;
						const position = await capture.start(request);
						started.set(request.subscription, position);
						return position;
					},
					async stop(subscription) {
						started.delete(subscription);
						await capture.stop(subscription);
					},
				},
			};
		},
	),
	// ── apply, retire ─────────────────────────────────────────────────────────
	variant(
		"apply-drops-a-delete",
		"apply leaves deletes out",
		"apply.idempotent-with-watermark",
		(inner) => {
			const apply = requirePort(inner, "apply");
			return {
				...inner,
				apply: {
					apply: (request) =>
						apply.apply({
							...request,
							changes: request.changes.filter(
								(change) => change.op !== "delete",
							),
						}),
					watermark: (request) => apply.watermark(request),
				},
			};
		},
	),
	variant(
		"stale-apply-accepted",
		"a conditional apply ignores the watermark it names",
		"apply.stale-watermark-is-refused",
		(inner) => {
			const apply = requirePort(inner, "apply");
			return {
				...inner,
				apply: {
					apply: ({ expectedWatermark: _ignored, ...request }) =>
						apply.apply(request),
					watermark: (request) => apply.watermark(request),
				},
			};
		},
	),
	variant(
		"retire-ignores-digest",
		"retire removes the scope whatever digest it is handed",
		"retire.refused-unless-proven",
		(inner) => {
			const retire = requirePort(inner, "retire");
			const verify = requirePort(inner, "verify");
			return {
				...inner,
				retire: {
					async retire(request) {
						const expected = await verify.digest({
							scope: request.scope,
							buckets: request.expected.buckets.length,
						});
						return retire.retire({ ...request, expected });
					},
				},
			};
		},
	),
	variant(
		"retire-not-redeliverable",
		"a retire sent again after it committed is refused",
		"retire.redelivery-is-harmless",
		(inner) => {
			const retire = requirePort(inner, "retire");
			const verify = requirePort(inner, "verify");
			return {
				...inner,
				retire: {
					async retire(request) {
						const current = await verify.digest({
							scope: request.scope,
							buckets: 1,
						});
						if (current.count === 0 && request.expected.count > 0) {
							throw new DataCoreError(
								"RETIRE_REFUSED",
								"the store no longer matches the verified digest",
							);
						}
						return retire.retire(request);
					},
				},
			};
		},
	),
	variant(
		"retire-replayed-as-deletes",
		"what a retire removed is handed to a later subscription as deletes",
		"retire.leaves-nothing-to-capture",
		(inner) => {
			const retire = requirePort(inner, "retire");
			const capture = requirePort(inner, "capture");
			const retired: {
				readonly scope: DatasetScope;
				readonly keys: RecordMutation[];
			}[] = [];
			const delivered = new Set<string>();
			return {
				...inner,
				retire: {
					async retire(request) {
						const keys = (await rowsOf(inner, request.scope)).map((row) =>
							deleteMutation(row.tenant, row.key),
						);
						const receipt = await retire.retire(request);
						retired.push({ scope: request.scope, keys });
						return receipt;
					},
				},
				capture: {
					...capture,
					async read(request) {
						const batch = await capture.read(request);
						if (delivered.has(request.subscription)) return batch;
						delivered.add(request.subscription);
						const schema = await inner.datasets.describeDataset(
							request.scope.dataset,
						);
						if (schema === undefined) return batch;
						const replayed: ChangeEnvelope[] = retired
							.filter((entry) => entry.scope.dataset === request.scope.dataset)
							.flatMap((entry) => entry.keys)
							.filter(
								(key) =>
									request.scope.tenant === "" ||
									key.tenant === request.scope.tenant,
							)
							.map((key) => envelopeOf(schema, key, batch.position));
						return { ...batch, changes: [...replayed, ...batch.changes] };
					},
				},
			};
		},
	),
	// ── refusals ──────────────────────────────────────────────────────────────
	variant(
		"refusal-carries-the-token",
		"a fenced write's refusal names the token that would have opened the fence",
		"errors.refusals-carry-no-secrets",
		(inner) => ({
			...inner,
			records: {
				async write(request) {
					try {
						return await inner.records.write(request);
					} catch (cause) {
						if (!(cause instanceof FencedWriteError)) throw cause;
						const tokens = await coveringTokens(
							inner,
							request.dataset,
							request.mutations,
						);
						// Still the right class of refusal — with the credential
						// riding along underneath it.
						throw Object.defineProperty(cause, "cause", {
							value: new Error(`expected one of ${tokens.join(", ")}`),
						});
					}
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	variant(
		"refusal-carries-the-record",
		"an invalid write's refusal quotes the record it refused",
		"errors.refusals-carry-no-secrets",
		(inner) => ({
			...inner,
			records: {
				async write(request) {
					try {
						return await inner.records.write(request);
					} catch (cause) {
						if (
							!(cause instanceof DataCoreError) ||
							cause.code !== "INVALID_RECORD"
						) {
							throw cause;
						}
						throw new DataCoreError("INVALID_RECORD", cause.message, {
							detail: {
								refused: canonicalEncode(
									request.mutations.map((entry) => entry.record ?? null),
								),
							},
						});
					}
				},
				read: (request) => inner.records.read(request),
			},
		}),
	),
	// ── crash windows ─────────────────────────────────────────────────────────
	variant(
		"capture-stop-not-repeatable",
		"stopping a subscription that is already gone is an error",
		"pattern.snapshot-and-tail.crash-windows.cutover",
		(inner) => {
			const capture = requirePort(inner, "capture");
			const live = new Set<string>();
			return {
				...inner,
				capture: {
					...capture,
					async start(request) {
						const position = await capture.start(request);
						live.add(request.subscription);
						return position;
					},
					async stop(subscription) {
						if (!live.delete(subscription)) {
							throw new Error("no such subscription");
						}
						await capture.stop(subscription);
					},
				},
			};
		},
	),
];

/**
 * A reference engine that declares a record bound, and — when `enforced` —
 * holds to it. The reference engine itself states none, so this is also what
 * lets the kit's size case run against a correct engine.
 */
export const DECLARED_RECORD_BOUND = 4096;

export function bounded(
	inner: EngineBinding,
	enforced: boolean,
): EngineBinding {
	const check = (mutations: readonly RecordMutation[]): void => {
		if (!enforced) return;
		for (const mutation of mutations) {
			if (
				canonicalEncode(mutation.record ?? null).length > DECLARED_RECORD_BOUND
			) {
				throw new DataCoreError(
					"INVALID_RECORD",
					"a record is larger than this engine stores",
				);
			}
		}
	};
	return {
		...inner,
		declaration: {
			...inner.declaration,
			maxRecordBytes: DECLARED_RECORD_BOUND,
		},
		records: {
			write(request) {
				check(request.mutations);
				return inner.records.write(request);
			},
			read: (request) => inner.records.read(request),
		},
	};
}

/**
 * A native transfer whose `stop` is not repeatable, on both sides of a pair.
 * Native variants need a staged pair, so this one is built apart from the
 * list above.
 */
export function nativeStopNotRepeatable(): BrokenVariant {
	const breakStop = (inner: EngineBinding): EngineBinding => {
		const port = inner.nativeTransfer;
		if (port === undefined) return inner;
		const stopped = new Set<string>();
		return {
			...inner,
			nativeTransfer: {
				...port,
				async stop(request) {
					if (stopped.has(request.transfer)) {
						throw new Error("the transfer was already stopped");
					}
					stopped.add(request.transfer);
					await port.stop(request);
				},
			},
		};
	};
	const shared = createReferenceNativeLink();
	return {
		name: "native-stop-not-repeatable",
		defect: "stopping a native transfer a second time is an error",
		caughtBy: "pattern.snapshot-and-tail.native.zero-loss-under-load",
		harness: {
			create: () => breakStop(createReferenceEngine({ native: shared })),
			createNativePair() {
				const link = createReferenceNativeLink();
				return {
					source: breakStop(createReferenceEngine({ native: link })),
					target: breakStop(createReferenceEngine({ native: link })),
				};
			},
			positionPastHead: referencePositionPastHead,
		},
	};
}
