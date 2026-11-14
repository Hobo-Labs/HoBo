// Reference adapters and harnesses for the nine @hobo/cd port suites. Each
// harness takes an optional mutant that breaks exactly one port property.
import {
	type ArtifactStoreHarness,
	type ArtifactVerifierHarness,
	type ArtifactWorld,
	CD_RECONCILE_STATUS,
	CD_SUBSCRIPTION_KIND,
	type CdOutcomeLike,
	type DesiredStateChangeLike,
	type DiscoveredArtifactLike,
	type HealthSourceHarness,
	type HealthWorld,
	type ProvenanceCases,
	type ProvenanceInputLike,
	type ProvenanceRefLike,
	type PublisherHarness,
	type RealizeInputLike,
	type RealizerHarness,
	type ReconcileObservationLike,
	type ReconcilerLeaseLike,
	type ReconcilerTransportHarness,
	type SubscriptionDriverHarness,
	type TrafficShifterHarness,
} from "@hobo/conformance";
import {
	type ApplyResult,
	type EventPosition,
	type FenceToken,
	parseRoutingPlan,
	type RoutingPlan,
	type RoutingStatus,
	type TrafficRoutingOfferingId,
} from "@hobo/core";
import { createHmac } from "node:crypto";
import { abortedRefusal, ManualClock, ok, type RefCtx, reason, refCtx, refuse, sha256 } from "./common.js";

// ── Realizer ─────────────────────────────────────────────────────────────────

export type RefSet = Readonly<{ setId: string; campId: string; freightId: string }>;
export type RefResolved = Readonly<{ digests: readonly string[] }>;
export type RealizerMutant = "trusts-provider" | "reapplies" | "ignores-abort" | "untyped-failure";

class RefTarget {
	applied: string | undefined;
	count = 0;
	#fail = false;
	#lie = false;
	mutations = (): number => this.count;
	failNextApply = (): void => {
		this.#fail = true;
	};
	lieOnNextApply = (): void => {
		this.#lie = true;
	};
	apply(setId: string): void {
		this.count += 1;
		if (this.#fail) {
			this.#fail = false;
			throw new Error("provider returned 503");
		}
		if (this.#lie) {
			this.#lie = false;
			return;
		}
		this.applied = setId;
	}
}

// SAFETY: the reference lease fence is a positive bigint, which is what the brand marks.
const FENCE = 7n as FenceToken;

export function refRealizerHarness(mutant?: RealizerMutant): RealizerHarness<RefSet, RefResolved, RefCtx> {
	let target = new RefTarget();
	const observation = (
		input: RealizeInputLike<RefSet, RefResolved>,
		status: number,
		reasons: readonly ReturnType<typeof reason>[] = [],
	): ReconcileObservationLike => ({
		campId: input.campId,
		setId: input.desired.setId,
		fenceToken: String(input.fence),
		status,
		resources: [{ resource: "app", healthy: status === CD_RECONCILE_STATUS.CONVERGED, driftKind: "" }],
		reasons,
	});
	const observe = async (input: RealizeInputLike<RefSet, RefResolved>): Promise<ReconcileObservationLike> =>
		observation(input, target.applied === input.desired.setId ? CD_RECONCILE_STATUS.CONVERGED : CD_RECONCILE_STATUS.CONVERGING);
	const converge = async (input: RealizeInputLike<RefSet, RefResolved>): Promise<ReconcileObservationLike> => {
		if (input.signal.aborted && mutant !== "ignores-abort") {
			return observation(input, CD_RECONCILE_STATUS.BLOCKED, [reason("aborted", "converge aborted before apply", "retry with a live signal")]);
		}
		const before = await observe(input);
		if (before.status === CD_RECONCILE_STATUS.CONVERGED && mutant !== "reapplies") return before;
		try {
			target.apply(input.desired.setId);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (mutant === "untyped-failure") return observation(input, CD_RECONCILE_STATUS.BLOCKED, [reason("", text, "")]);
			return observation(input, CD_RECONCILE_STATUS.BLOCKED, [reason("provider-error", text, "check provider health; the reconciler retries by observation")]);
		}
		if (mutant === "trusts-provider") return observation(input, CD_RECONCILE_STATUS.CONVERGED);
		return observe(input);
	};
	return {
		subject: mutant ? `reference-realizer[${mutant}]` : "reference-realizer",
		create: async () => {
			target = new RefTarget();
			return { realizer: { converge, observe }, target };
		},
		input: (signal = new AbortController().signal) => ({
			campId: "camp-1",
			desired: { setId: "set-2", campId: "camp-1", freightId: "sha256:f" },
			resolved: { digests: ["sha256:a"] },
			reconcilerId: "rec-1",
			fence: FENCE,
			signal,
		}),
		ctx: () => refCtx(),
	};
}

// ── TrafficShifter ───────────────────────────────────────────────────────────

export type TrafficMutant = "claims-full-without-capability" | "forgets-status";

export function routingPlan(percent: number): RoutingPlan {
	const backends = [
		{ id: "stable", service: "web", weight: 100 - percent },
		{ id: "candidate", service: "web", weight: percent },
	];
	return parseRoutingPlan({
		planId: `plan-${percent}`,
		intent: { service: "web", tenantId: "conformance", rules: [{ backends, weightStrategy: "static" }] },
		backends,
		createdAt: "2026-11-12T00:00:00.000Z",
	});
}

export function refTrafficHarness(mutant?: TrafficMutant): TrafficShifterHarness<RefCtx> {
	const make = (offered: readonly TrafficRoutingOfferingId[]) => {
		const plans = new Map<string, RoutingStatus>();
		return {
			offerings: async () => [...offered],
			shift: async (input: Readonly<{ campId: string; plan: RoutingPlan; signal: AbortSignal }>): Promise<ApplyResult> => {
				if (input.signal.aborted) throw new Error("aborted");
				const capable = offered.length > 0 || mutant === "claims-full-without-capability";
				const realized = capable ? "full" : "none";
				if (mutant !== "forgets-status") plans.set(input.plan.planId, { planId: input.plan.planId, active: capable, realized, notes: [] });
				return { planId: input.plan.planId, provider: "simple", realized, notes: capable ? [] : ["no traffic offering"], unmet: capable ? [] : ["weighted-backends"] };
			},
			status: async (_campId: string, planId: RoutingPlan["planId"]) => plans.get(planId) ?? null,
		};
	};
	return {
		subject: mutant ? `reference-traffic[${mutant}]` : "reference-traffic",
		campId: "camp-1",
		create: async () => make(["edge.canary", "lb.weighted"]),
		createWithoutTraffic: async () => make([]),
		plan: routingPlan,
		ctx: () => refCtx(),
	};
}

// ── HealthSource ─────────────────────────────────────────────────────────────

export type HealthMutant = "fabricates-on-empty" | "ignores-cohort";
export type RefHealthQuery = Readonly<{ name: string; cohortLabel: string }>;

export function refHealthHarness(mutant?: HealthMutant): HealthSourceHarness<RefHealthQuery, RefCtx> {
	return {
		subject: mutant ? `reference-health[${mutant}]` : "reference-health",
		expectedKind: 1,
		campId: "camp-1",
		query: () => ({ name: "error_rate", cohortLabel: "track" }),
		ctx: () => refCtx(),
		create: async (world: HealthWorld) => ({
			kind: 1,
			query: async (input) => {
				if (input.signal.aborted) return abortedRefusal();
				if (world.unreachable) return refuse("health-source-unreachable", "connection refused by the metrics backend", "check the endpoint_ref and network path; verification fails closed meanwhile");
				const series = input.cohort === 2 && mutant !== "ignores-cohort" ? world.baseline : world.canary;
				const values = series ?? [];
				return ok({ values: values.length === 0 && mutant === "fabricates-on-empty" ? [0, 0, 0] : [...values], fromMs: input.fromMs, toMs: input.toMs });
			},
		}),
	};
}

// ── PublisherPort ────────────────────────────────────────────────────────────

export type PublisherMutant = "converged-on-publish" | "writes-every-time";

export function refPublisherHarness(mutant?: PublisherMutant): PublisherHarness<RefSet, RefResolved, RefCtx> {
	return {
		subject: mutant ? `reference-publisher[${mutant}]` : "reference-publisher",
		desired: (n) => ({ set: { setId: `set-${n}`, campId: "camp-1", freightId: `sha256:${n}` }, resolved: { digests: [`sha256:${n}`] } }),
		ctx: () => refCtx(),
		create: async () => {
			const revisions = new Map<string, string>();
			let synced: string | undefined;
			let writes = 0;
			const engine = {
				sync: async (revision: string) => {
					synced = revision;
				},
				writes: () => writes,
			};
			const publisher = {
				target: "git+https://git.example.test/fleet/deploy.git#main:camps/camp-1",
				publish: async (input: Readonly<{ set: RefSet; resolved: RefResolved; signal: AbortSignal }>): Promise<CdOutcomeLike<Readonly<{ revision: string }>>> => {
					if (input.signal.aborted) return abortedRefusal();
					const revision = sha256(`${input.set.setId}:${input.resolved.digests.join(",")}`).slice(7, 47);
					if (revisions.get(input.set.setId) !== revision || mutant === "writes-every-time") {
						writes += 1;
						revisions.set(input.set.setId, revision);
					}
					return ok({ revision });
				},
				observe: async (input: Readonly<{ set: RefSet; revision: string }>): Promise<ReconcileObservationLike> => ({
					campId: input.set.campId,
					setId: input.set.setId,
					fenceToken: "1",
					status: synced === input.revision || mutant === "converged-on-publish" ? CD_RECONCILE_STATUS.CONVERGED : CD_RECONCILE_STATUS.CONVERGING,
					resources: [],
					reasons: [],
				}),
			};
			return { publisher, engine };
		},
	};
}

// ── ReconcilerTransport ──────────────────────────────────────────────────────

export type TransportMutant = "no-fencing" | "replays-checkpointed";
type RefLease = ReconcilerLeaseLike;

export function refTransportHarness(mutant?: TransportMutant): ReconcilerTransportHarness<RefLease, ReconcileObservationLike> {
	const ttlMs = 30_000;
	return {
		subject: mutant ? `reference-transport[${mutant}]` : "reference-transport",
		campId: "camp-1",
		reconcilerId: "rec-1",
		ttlMs,
		create: async () => {
			const clock = new ManualClock();
			let holder: RefLease | undefined;
			let fence = 0n;
			let checkpoint = 0n;
			const changes: DesiredStateChangeLike[] = [];
			const current = (lease: RefLease) =>
				mutant === "no-fencing" || (holder !== undefined && holder.fence === lease.fence && holder.expiresAtMs > clock.now());
			const stale = <T>(): CdOutcomeLike<T> => refuse("stale-fence", "the lease was superseded or expired", "re-claim the Camp and resume from the committed checkpoint");
			const transport = {
				claim: async (input: Readonly<{ reconcilerId: string; campId: string; holderId: string; ttlMs: number }>): Promise<CdOutcomeLike<RefLease>> => {
					if (holder && holder.expiresAtMs > clock.now()) return refuse("camp-leased", `Camp ${input.campId} is leased by ${holder.holderId}`, "wait for the lease to expire or be released");
					fence += 1n;
					// SAFETY: the counter starts at 1 and only grows, which is what FenceToken marks.
					holder = { reconcilerId: input.reconcilerId, campId: input.campId, holderId: input.holderId, fence: fence as FenceToken, expiresAtMs: clock.now() + input.ttlMs };
					return ok(holder);
				},
				renew: async (lease: RefLease): Promise<CdOutcomeLike<RefLease>> => {
					if (!current(lease)) return stale();
					holder = { ...lease, expiresAtMs: clock.now() + ttlMs };
					return ok(holder);
				},
				release: async (lease: RefLease) => {
					if (holder?.fence === lease.fence) holder = undefined;
				},
				feed: async function* (input: Readonly<{ lease: RefLease; signal: AbortSignal }>) {
					const from = mutant === "replays-checkpointed" ? 0n : checkpoint;
					for (const change of changes) {
						if (input.signal.aborted) return;
						if (change.position > from) yield change;
					}
				},
				report: async (lease: RefLease): Promise<CdOutcomeLike<EventPosition>> => {
					if (!current(lease)) return stale();
					// SAFETY: status positions share the decimal position space of the journal.
					return ok(BigInt(changes.length + 1000) as EventPosition);
				},
				checkpoint: async (lease: RefLease, position: EventPosition): Promise<CdOutcomeLike<EventPosition>> => {
					if (!current(lease)) return stale();
					if (position > checkpoint) checkpoint = position;
					// SAFETY: the committed checkpoint is always a position the feed delivered.
					return ok(checkpoint as EventPosition);
				},
			};
			return {
				transport,
				advance: (ms: number) => clock.advance(ms),
				publish: async (n: number) => {
					// SAFETY: positions are the 1-based index of the change in the Camp's spec stream.
					changes.push({ position: BigInt(changes.length + 1) as EventPosition, set: { setId: `set-${n}`, campId: "camp-1", freightId: `sha256:${n}` } });
				},
				observation: (lease: RefLease): ReconcileObservationLike => ({ campId: lease.campId, setId: "set-1", fenceToken: String(lease.fence), status: CD_RECONCILE_STATUS.CONVERGED, resources: [], reasons: [] }),
			};
		},
	};
}

// ── ArtifactStore ────────────────────────────────────────────────────────────

export type StoreMutant = "no-verify-on-read" | "duplicate-listing";

export function refStoreHarness(mutant?: StoreMutant): ArtifactStoreHarness<RefCtx> {
	return {
		subject: mutant ? `reference-store[${mutant}]` : "reference-store",
		ctx: () => refCtx(),
		create: async () => {
			const blobs = new Map<string, Uint8Array>();
			const listing: string[] = [];
			const store = {
				backend: "memory",
				put: async (bytes: Uint8Array, meta: Readonly<{ name: string; kind: number; mediaType: string }>) => {
					const digest = sha256(bytes);
					if (!blobs.has(digest) || mutant === "duplicate-listing") listing.push(digest);
					blobs.set(digest, new Uint8Array(bytes));
					return { name: meta.name, kind: meta.kind, digest, coordinate: `store://${digest}`, sizeBytes: BigInt(bytes.length), mediaType: meta.mediaType, ecosystem: "store" };
				},
				get: async (digest: `sha256:${string}`) => {
					const bytes = blobs.get(digest);
					if (!bytes) return undefined;
					if (mutant !== "no-verify-on-read" && sha256(bytes) !== digest) return undefined;
					return new Uint8Array(bytes);
				},
				has: async (digest: `sha256:${string}`) => blobs.has(digest),
				list: async function* () {
					for (const digest of listing) if (blobs.has(digest)) yield digest;
				},
				delete: async (digest: `sha256:${string}`) => {
					blobs.delete(digest);
				},
			};
			return {
				store,
				corrupt: async (digest: `sha256:${string}`) => {
					const bytes = blobs.get(digest);
					if (bytes) blobs.set(digest, Uint8Array.from(bytes, (b, i) => (i === 0 ? b ^ 0xff : b)));
				},
			};
		},
	};
}

// ── ArtifactVerifier ─────────────────────────────────────────────────────────

export type ArtifactVerifierMutant = "passes-unreachable" | "rewrites-digest";
export type RefManifest = Readonly<{ bindle: string; artifacts: readonly Readonly<{ name: string; digest: string; coordinate: string }>[] }>;

export function refArtifactVerifierHarness(mutant?: ArtifactVerifierMutant): ArtifactVerifierHarness<RefManifest, RefCtx> {
	const bytes = new TextEncoder().encode("app.wasm bytes");
	const manifest: RefManifest = { bindle: "shop", artifacts: [{ name: "app", digest: sha256(bytes), coordinate: "oci://registry.example.test/shop/app@1.0.0" }] };
	return {
		subject: mutant ? `reference-artifact-verifier[${mutant}]` : "reference-artifact-verifier",
		manifest: () => manifest,
		digests: (m) => m.artifacts.map((a) => a.digest),
		ctx: () => refCtx(),
		create: async (world: ArtifactWorld) => ({
			verify: async (m: RefManifest): Promise<CdOutcomeLike<RefManifest>> => {
				for (const artifact of m.artifacts) {
					if (world === "unreachable") {
						if (mutant === "passes-unreachable") continue;
						return refuse("artifact-unreachable", `${artifact.coordinate} did not answer`, "restore the registry or mirror; promotion stays blocked until the digest is read");
					}
					const served = world === "tampered" ? sha256(new TextEncoder().encode("other bytes")) : artifact.digest;
					if (served !== artifact.digest) return refuse("artifact-digest-mismatch", `${artifact.coordinate} serves ${served}`, "republish the artifact; never substitute a digest");
				}
				if (mutant === "rewrites-digest") return ok({ ...m, artifacts: m.artifacts.map((a) => ({ ...a, digest: sha256(a.coordinate) })) });
				return ok(m);
			},
		}),
	};
}

// ── ProvenanceVerifier ───────────────────────────────────────────────────────

export type ProvenanceMutant = "skips-signer-pin" | "skips-subject-binding" | "throws-on-garbage";

const TEST_ROOT = "conformance-test-root";
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function statement(digest: string, builderId: string): Uint8Array {
	return utf8(JSON.stringify({
		_type: "https://in-toto.io/Statement/v1",
		subject: [{ name: "app", digest: { sha256: digest.slice(7) } }],
		predicateType: "https://slsa.dev/provenance/v1",
		predicate: { runDetails: { builder: { id: builderId } } },
	}));
}

function bundle(stmt: Uint8Array, signer: string): Uint8Array {
	return utf8(JSON.stringify({ signer, signature: createHmac("sha256", TEST_ROOT).update(stmt).update(signer).digest("hex") }));
}

type ParsedStatement = Readonly<{ subjects: readonly string[]; builderId: string }>;

function parseStatement(bytes: Uint8Array): ParsedStatement | undefined {
	try {
		const parsed: { _type?: string; subject?: { digest?: { sha256?: string } }[]; predicate?: { runDetails?: { builder?: { id?: string } } } } = JSON.parse(new TextDecoder().decode(bytes));
		if (parsed._type !== "https://in-toto.io/Statement/v1") return undefined;
		const builderId = parsed.predicate?.runDetails?.builder?.id;
		const subjects = (parsed.subject ?? []).map((s) => `sha256:${s.digest?.sha256 ?? ""}`);
		return builderId ? { subjects, builderId } : undefined;
	} catch {
		return undefined;
	}
}

function parseBundle(bytes: Uint8Array): Readonly<{ signer: string; signature: string }> | undefined {
	try {
		const parsed: { signer?: string; signature?: string } = JSON.parse(new TextDecoder().decode(bytes));
		return parsed.signer && parsed.signature ? { signer: parsed.signer, signature: parsed.signature } : undefined;
	} catch {
		return undefined;
	}
}

export function refProvenanceHarness(mutant?: ProvenanceMutant): import("@hobo/conformance").ProvenanceVerifierHarness<RefCtx> {
	const digest = sha256("app.wasm bytes");
	const builder = "https://ci.example.test/builders/trusted@v1";
	const signer = "https://ci.example.test/shop/.ci/release.yml@refs/heads/main";
	const subjects = [{ name: "app", kind: 1, digest, coordinate: "oci://registry.example.test/shop/app@1.0.0" }];
	const base = (stmt: Uint8Array, signedBy = signer): ProvenanceInputLike => ({ statement: stmt, bundle: bundle(stmt, signedBy), subjects, trustedBuilderIds: [builder], trustedSignerIdentities: [signer] });
	const good = statement(digest, builder);
	const cases: ProvenanceCases = {
		valid: base(good),
		tamperedSubject: base(statement(sha256("other bytes"), builder)),
		untrustedBuilder: base(statement(digest, "https://evil.example.test/builder")),
		untrustedSigner: base(good, "https://evil.example.test/workflow"),
		unsigned: { statement: good, subjects, trustedBuilderIds: [builder], trustedSignerIdentities: [signer] },
		malformed: { ...base(good), statement: new TextEncoder().encode("not a statement") },
	};
	const verify = async (input: ProvenanceInputLike): Promise<CdOutcomeLike<readonly ProvenanceRefLike[]>> => {
		const parsed = parseStatement(input.statement);
		if (!parsed) {
			if (mutant === "throws-on-garbage") throw new SyntaxError("bad statement");
			return refuse("provenance-malformed", "the statement is not an in-toto v1 Statement", "publish an in-toto v1 Statement with SLSA provenance");
		}
		if (!input.trustedBuilderIds.includes(parsed.builderId)) return refuse("provenance-untrusted-builder", `builder ${parsed.builderId} is not trusted`, "pin the builder id on the subscription or rebuild on a trusted builder");
		const signed = input.bundle ? parseBundle(input.bundle) : undefined;
		if (input.trustedSignerIdentities.length > 0) {
			if (!signed) return refuse("provenance-unsigned", "no signature bundle accompanies the statement", "attach the Sigstore bundle");
			const expected = createHmac("sha256", TEST_ROOT).update(input.statement).update(signed.signer).digest("hex");
			if (expected !== signed.signature) return refuse("provenance-bad-signature", "the bundle does not verify", "re-sign the statement");
			if (mutant !== "skips-signer-pin" && !input.trustedSignerIdentities.includes(signed.signer)) return refuse("provenance-untrusted-signer", `signer ${signed.signer} is not trusted`, "pin the signer identity or sign with a trusted workflow");
		}
		for (const subject of input.subjects) {
			if (mutant !== "skips-subject-binding" && !parsed.subjects.includes(subject.digest)) return refuse("provenance-subject-mismatch", `the statement does not name ${subject.digest}`, "attest the exact artifact digest");
		}
		return ok([{ statementDigest: sha256(input.statement), builderId: parsed.builderId, signerIdentity: signed?.signer ?? "", verified: true, verifier: "hobo-jwt", subjectDigests: parsed.subjects }]);
	};
	return { subject: mutant ? `reference-provenance[${mutant}]` : "reference-provenance", create: async () => ({ verify }), cases: () => cases, ctx: () => refCtx() };
}

// ── SubscriptionDriver ───────────────────────────────────────────────────────

export type SubscriptionMutant = "ignores-cursor" | "ignores-limit" | "unpinned";
export type RefSubscription = Readonly<{ name: string; limit: number }>;

export function refSubscriptionHarness(mutant?: SubscriptionMutant): SubscriptionDriverHarness<RefSubscription, RefCtx> {
	return {
		subject: mutant ? `reference-oci-driver[${mutant}]` : "reference-oci-driver",
		expectedKind: CD_SUBSCRIPTION_KIND.OCI_REPOSITORY,
		source: "shop",
		subscription: (limit) => ({ name: "app", limit }),
		newer: (index) => `1.${index}.0`,
		ctx: () => refCtx(),
		create: async (initial) => {
			const versions = [...initial];
			let down = false;
			const driver = {
				kind: CD_SUBSCRIPTION_KIND.OCI_REPOSITORY,
				discover: async (input: Readonly<{ source: string; subscription: RefSubscription; cursor?: string; signal: AbortSignal }>): Promise<CdOutcomeLike<Readonly<{ artifacts: readonly DiscoveredArtifactLike[]; cursor: string }>>> => {
					if (input.signal.aborted) return abortedRefusal();
					if (down) return refuse("source-unreachable", "the registry answered 503", "the poll backs off and retries; the cursor is unchanged");
					const from = mutant === "ignores-cursor" ? 0 : Number(input.cursor ?? "0");
					const limit = mutant === "ignores-limit" ? versions.length : input.subscription.limit;
					const slice = versions.slice(from, from + limit);
					const artifacts = slice.map((version) => ({
						source: input.source,
						subscription: input.subscription.name,
						version,
						commit: "",
						artifact: { name: "app", kind: 4, digest: mutant === "unpinned" ? version : sha256(`app:${version}`), coordinate: `oci://registry.example.test/shop/app:${version}` },
					}));
					return ok({ artifacts, cursor: String(from + slice.length) });
				},
			};
			return {
				driver,
				release: async (version: string) => {
					versions.push(version);
				},
				outage: (value: boolean) => {
					down = value;
				},
			};
		},
	};
}
