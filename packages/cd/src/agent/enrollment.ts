// Agent enrollment (D5, D19, I3, I24). An actor per reconciler on
// `cd-reconciler-<id>`; a token actor per bootstrap token on
// `cd-bootstrap-<sha256(token)>`. Every command catches up from the journal
// and appends with expectedSeq (CAS, retried on conflict), so Station
// replicas stay consistent and revocation is effective on the next request.
//
//   issueToken  governed `reconciler.enroll`; single-use, scoped to one Camp
//               set; only the token's SHA-256 is recorded.
//   enroll      consumes the token (CAS on the token stream), registers the
//               public JWK; PENDING unless every governing Rail lists the
//               token's Camp set in `auto_accept_scopes` (recorded).
//   approveKey  grant 1, governed `reconciler.approve-key`.
//   accept      grant 2, governed `reconciler.accept`; Camps within the token
//               scope only; separate principals when any governing Rail (or
//               the default) sets `separate_approvers`.
//   activate    ACCEPTED only; a DPoP proof of the enrolled key → JWT-SVID
//               with `cnf.jkt` (RFC 7800/9449).
//   refresh     a live SVID + DPoP (with `ath`) → a new SVID.
//   revoke      governed `reconciler.revoke`; the next request is refused.
//   verify      SVID signature/issuer/audience/expiry, DPoP (htm, htu, iat,
//               ath, jti replay), key binding, enrollment state.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	create,
	fromJson,
	type JsonValue as PbJsonValue,
	toJson,
} from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type EventInput,
	EventStoreError,
	type JsonObject,
	type PrincipalRef,
} from "@hobo/core";
import {
	createInMemoryKms,
	type JwtSvidClaims,
	JwtSvidIssuer,
	verifyJwtWithJwks,
} from "@hobo/identity";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	CampConditionRecordSchema,
	CampConditionType,
	ConditionStatus,
	EnrollmentState,
	ReconcilerMode,
	type ReconcilerRecord,
	ReconcilerRecordSchema,
	SignalSource,
} from "../_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	ENROLLMENT_INCOMPLETE,
} from "../events.js";
import {
	headerOf,
	isNumber,
	isText,
	isWireObject,
	text,
	texts,
	type WireObject,
} from "../feed/json.js";
import type {
	AgentEnrollment,
	CampId,
	CampInventory,
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	FeedRequest,
	Outcome,
	RailDeliveryReader,
	ReconcilerId,
	Refusal,
	TelemetrySink,
} from "../ports.js";
import { createDpopProofVerifier } from "./dpop-verifier.js";
import { type AgentFailureCode, agentRefusal, messageOf } from "./errors.js";
import { AGENT_EVENT_SCHEMA, AGENT_EVENTS, AGENT_STREAMS } from "./events.js";
import {
	type JwkThumbprint,
	jwkThumbprint,
	type PublicJwk,
	parsePublicJwk,
	publicJwkJson,
} from "./jose.js";
import { createMeter } from "./metrics.js";
import { createJournalReplayStore, type DpopReplayStore } from "./replay.js";

// public-contract: audience of delivery-feed SVIDs.
export const FEED_SVID_AUDIENCE = "hobo-cd-feed" as const;
// public-contract: path of SVID activation and refresh on the delivery feed.
export const SVID_REFRESH_PATH = "/v1/cd/svid/refresh" as const;
// public-contract: bootstrap token prefix.
export const BOOTSTRAP_TOKEN_PREFIX = "hcd_bt_" as const;

export type AgentEnrollmentDeps = CdBase & {
	readonly authorizer: CdAuthorizer;
	readonly rails: RailDeliveryReader;
	readonly inventory: CampInventory;
	/** SVID issuer. Defaults to a process-local KMS key: SVIDs then die with the process and agents re-activate. */
	readonly issuer?: JwtSvidIssuer;
	/** SPIFFE trust domain of SVID subjects; defaults to the tenant. */
	readonly trustDomain?: string;
	/** jti replay store; defaults to the journal-backed store. */
	readonly replay?: DpopReplayStore;
	readonly telemetry?: TelemetrySink;
	/** The Station's public origin (`https://station.example`); when set, `htu` hosts are checked too. */
	readonly publicOrigin?: string;
};

type View = {
	seq: number;
	record: ReconcilerRecord;
	jwk: PublicJwk | undefined;
	scopeCampIds: readonly string[];
};

type TokenView = Readonly<{
	seq: number;
	campSet: string;
	campIds: readonly string[];
	mode: ReconcilerMode;
	expiresAtMs: number;
	consumedBy?: string;
	reconcilerId?: string;
}>;

const STATION: PrincipalRef = { kind: "service", id: "cd-station" };
const MAX_ATTEMPTS = 8;

function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Reconciler id derived from the key thumbprint: one key, one reconciler. */
export function reconcilerIdFor(thumbprint: JwkThumbprint): ReconcilerId {
	// SAFETY: a deterministic function of the enrolled key is the reconciler's identity.
	return `agent-${sha256Hex(thumbprint).slice(0, 32)}` as ReconcilerId;
}

function recordJson(record: ReconcilerRecord): JsonObject {
	// SAFETY: toJson of a message is always a JSON object.
	return toJson(ReconcilerRecordSchema, record) as JsonObject;
}

function str(value: PbJsonValue | undefined): string {
	return text(value) ?? "";
}

function bodyOf<T>(data: T): WireObject {
	return isWireObject(data) ? data : {};
}

export function createAgentEnrollment(d: AgentEnrollmentDeps): AgentEnrollment {
	const store: DurableEventStore = d.store;
	const meter = createMeter(d.telemetry, d.now);
	const issuer = d.issuer ?? defaultIssuer(d.tenant);
	const trustDomain = d.trustDomain ?? d.tenant;
	const replay =
		d.replay ??
		createJournalReplayStore({
			store,
			tenant: d.tenant,
			skewMs: CD_DEFAULTS.dpopSkewMs,
		});
	const dpop = createDpopProofVerifier(
		d.publicOrigin === undefined
			? { replay, skewMs: CD_DEFAULTS.dpopSkewMs }
			: {
					replay,
					skewMs: CD_DEFAULTS.dpopSkewMs,
					publicOrigin: d.publicOrigin,
				},
	);
	const cache = new Map<string, View>();

	// ── Folds ────────────────────────────────────────────────────────────
	async function load(reconcilerId: string): Promise<View | undefined> {
		const stream = CD_STREAMS.reconciler(reconcilerId);
		let view = cache.get(reconcilerId);
		for await (const event of store.read(stream, (view?.seq ?? 0) + 1)) {
			const data = bodyOf(event.data);
			if (event.type === CD_EVENTS.ReconcilerEnrollmentRequested) {
				const jwkJson = data.publicJwk;
				// SAFETY: a JSON object from the journal; parsePublicJwk narrows it to a PublicJwk.
				const parsed = isWireObject(jwkJson)
					? parsePublicJwk(jwkJson as JsonObject)
					: undefined;
				view = {
					seq: event.seq,
					record: fromJson(ReconcilerRecordSchema, data.reconciler ?? {}, {
						ignoreUnknownFields: true,
					}),
					jwk: parsed?.ok ? parsed.value : undefined,
					scopeCampIds: texts(data.scopeCampIds),
				};
				continue;
			}
			if (!view) continue;
			view.seq = event.seq;
			const record = view.record;
			if (event.type === CD_EVENTS.ReconcilerKeyApproved)
				record.keyApprovedBy = str(data.by);
			else if (event.type === CD_EVENTS.ReconcilerAccepted) {
				record.acceptedBy = str(data.by);
				record.campIds = texts(data.campIds);
				if (str(data.autoAcceptScope))
					record.autoAcceptedByScope = str(data.autoAcceptScope);
			} else if (event.type === CD_EVENTS.ReconcilerEnrolled)
				record.enrollment = EnrollmentState.ACCEPTED;
			else if (event.type === CD_EVENTS.ReconcilerRevoked) {
				record.enrollment = EnrollmentState.REVOKED;
				record.revokedAt = str(data.at);
			}
		}
		if (view) cache.set(reconcilerId, view);
		return view;
	}

	async function loadToken(tokenHash: string): Promise<TokenView | undefined> {
		let token: TokenView | undefined;
		for await (const event of store.read(AGENT_STREAMS.bootstrap(tokenHash))) {
			const data = bodyOf(event.data);
			if (event.type === AGENT_EVENTS.BootstrapTokenIssued)
				token = {
					seq: event.seq,
					campSet: str(data.campSet),
					campIds: texts(data.campIds),
					mode: isNumber(data.mode) ? data.mode : ReconcilerMode.UNSPECIFIED,
					expiresAtMs: Date.parse(str(data.expiresAt)),
				};
			else if (event.type === AGENT_EVENTS.BootstrapTokenConsumed && token)
				token = {
					...token,
					seq: event.seq,
					consumedBy: str(data.thumbprint),
					reconcilerId: str(data.reconcilerId),
				};
		}
		return token;
	}

	// ── Helpers ──────────────────────────────────────────────────────────
	async function govern(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<string>> {
		const decision = await d.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) {
			const reason = decision.reasons[0];
			return agentRefusal(
				"policy-denied",
				reason?.message ?? `${action} denied`,
				action,
			);
		}
		if (decision.value.proposalOnly)
			return agentRefusal(
				"proposal-only",
				`${principalKey(ctx.principal)} may only propose ${action}`,
				action,
			);
		return { ok: true, value: decision.value.decisionId };
	}

	async function append(
		stream: string,
		expectedSeq: number,
		events: readonly EventInput[],
		actor: PrincipalRef,
	): Promise<boolean> {
		try {
			await store.append(stream, [...events], {
				expectedSeq,
				actor,
				tenant: d.tenant,
			});
			return true;
		} catch (error) {
			if (
				error instanceof EventStoreError &&
				error.code === "OPTIMISTIC_SEQUENCE_CONFLICT"
			)
				return false;
			throw error;
		}
	}

	function event(type: string, data: JsonObject): EventInput {
		return { type, data: { schema: AGENT_EVENT_SCHEMA, ...data } };
	}

	async function governingRails(campIds: readonly string[]) {
		const rails = [];
		for (const campId of campIds) {
			// SAFETY: Camp ids recorded by the token were checked against the inventory at issue time.
			rails.push(await d.rails.forCamp(campId as CampId));
		}
		return rails;
	}

	async function separateApprovers(
		campIds: readonly string[],
	): Promise<boolean> {
		for (const rail of await governingRails(campIds)) {
			const enrollment = rail?.enrollment;
			if (!enrollment) {
				if (CD_DEFAULTS.enrollmentSeparateApprovers) return true;
			} else if (enrollment.separateApprovers) return true;
		}
		return campIds.length === 0
			? CD_DEFAULTS.enrollmentSeparateApprovers
			: false;
	}

	async function autoAccepts(
		scope: string,
		campIds: readonly string[],
	): Promise<boolean> {
		if (campIds.length === 0) return false;
		for (const rail of await governingRails(campIds))
			if (!rail?.enrollment?.autoAcceptScopes.includes(scope)) return false;
		return true;
	}

	async function reportCredential(
		view: View,
		status: ConditionStatus,
		reason: string,
	): Promise<void> {
		const ctx: CdContext = { tenant: d.tenant, principal: STATION, now: d.now };
		for (const campId of view.record.campIds) {
			const condition = create(CampConditionRecordSchema, {
				type: CampConditionType.CREDENTIAL_VALID,
				status,
				source: SignalSource.STATION,
				reason,
				since: iso(d.now()),
			});
			try {
				// SAFETY: accepted Camp ids are within the inventory-checked token scope.
				const result = await d.inventory.observe(
					{
						campId: campId as CampId,
						source: SignalSource.STATION,
						conditions: [condition],
						claims: [],
					},
					ctx,
				);
				if (!result.ok)
					meter("hobo.cd.agent.inventory_report_failures", 1, {
						code: result.reasons[0]?.code ?? "",
					});
			} catch {
				meter("hobo.cd.agent.inventory_report_failures", 1, {
					code: "inventory-unavailable",
				});
			}
		}
	}

	/** Load-modify-append with CAS retry. `plan` re-runs on each attempt against fresh state. */
	async function mutate(
		reconcilerId: string,
		ctx: CdContext,
		plan: (view: View) => Promise<Outcome<readonly EventInput[]>>,
	): Promise<Outcome<ReconcilerRecord>> {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const view = await load(reconcilerId);
			if (!view)
				return agentRefusal(
					"reconciler-unknown",
					`no enrollment for ${reconcilerId}`,
					reconcilerId,
				);
			if (view.record.enrollment === EnrollmentState.REVOKED)
				return agentRefusal(
					"reconciler-revoked",
					`${reconcilerId} was revoked at ${view.record.revokedAt}`,
					reconcilerId,
				);
			const planned = await plan(view);
			if (!planned.ok) return planned;
			if (planned.value.length === 0) return { ok: true, value: view.record };
			if (
				await append(
					CD_STREAMS.reconciler(reconcilerId),
					view.seq,
					planned.value,
					ctx.principal,
				)
			) {
				const fresh = await load(reconcilerId);
				return fresh
					? { ok: true, value: fresh.record }
					: agentRefusal(
							"store-unavailable",
							"enrollment vanished",
							reconcilerId,
						);
			}
		}
		return agentRefusal(
			"store-unavailable",
			`reconciler stream ${reconcilerId} kept changing`,
			reconcilerId,
		);
	}

	function completion(
		view: View,
		keyApprovedBy: string,
		acceptedBy: string,
		campIds: readonly string[],
		autoScope = "",
	): EventInput[] {
		if (!keyApprovedBy || !acceptedBy) return [];
		const record = create(ReconcilerRecordSchema, {
			...view.record,
			keyApprovedBy,
			acceptedBy,
			campIds: [...campIds],
			enrollment: EnrollmentState.ACCEPTED,
			autoAcceptedByScope: autoScope || view.record.autoAcceptedByScope,
		});
		return [
			event(CD_EVENTS.ReconcilerEnrolled, { reconciler: recordJson(record) }),
		];
	}

	// ── SVIDs ────────────────────────────────────────────────────────────
	async function issueSvid(
		view: View,
		kind: "activate" | "refresh",
		ctx: CdContext,
	): Promise<Outcome<{ svid: string; expiresAtMs: number }>> {
		const nowMs = ctx.now();
		const iat = Math.floor(nowMs / 1000);
		const exp = Math.floor((nowMs + CD_DEFAULTS.svidTtlMs) / 1000);
		const jti = randomUUID();
		const claims: JwtSvidClaims & { cnf: JsonObject; jti: string } = {
			sub: `spiffe://${trustDomain}/hobo-cd/reconciler/${view.record.reconcilerId}`,
			aud: FEED_SVID_AUDIENCE,
			tenant: d.tenant,
			parentPrincipal: { kind: "service", id: "cd-station" },
			codeVersion: { digest: "", version: "" },
			scope: view.record.campIds.map((campId) => ({
				port: "hobo:cd-feed",
				resource: campId,
				verbs: ["claim", "feed", "report", "checkpoint"],
			})),
			iat,
			nbf: iat,
			exp,
			jti,
			cnf: { jkt: view.record.keyThumbprint },
		};
		const svid = await issuer.signJwtSvid(claims);
		const expiresAtMs = exp * 1000;
		const appended = await append(
			CD_STREAMS.reconciler(view.record.reconcilerId),
			view.seq,
			[
				event(AGENT_EVENTS.SvidIssued, {
					jti,
					kind,
					expiresAt: iso(expiresAtMs),
				}),
			],
			ctx.principal,
		);
		if (!appended) {
			// A concurrent grant or revocation landed: re-check state before handing out a credential.
			const fresh = await load(view.record.reconcilerId);
			if (!fresh || fresh.record.enrollment !== EnrollmentState.ACCEPTED)
				return agentRefusal(
					"reconciler-revoked",
					"enrollment changed while issuing the SVID",
					view.record.reconcilerId,
				);
			return issueSvid(fresh, kind, ctx);
		}
		meter("hobo.cd.agent.svids_issued", 1, { kind });
		await reportCredential(
			view,
			ConditionStatus.TRUE,
			`expires-at:${iso(expiresAtMs)}`,
		);
		return { ok: true, value: { svid, expiresAtMs } };
	}

	type SvidClaims = Readonly<{ reconcilerId: string; jkt: string }>;

	async function verifySvid(
		svid: string,
		nowMs: number,
	): Promise<Outcome<SvidClaims>> {
		try {
			const verified = await verifyJwtWithJwks(svid, issuer.jwks(), {
				issuer: issuer.issuerUrl,
				audience: FEED_SVID_AUDIENCE,
				now: Math.floor(nowMs / 1000),
			});
			const sub = verified.claims.sub;
			const cnf = verified.claims.cnf;
			const prefix = `spiffe://${trustDomain}/hobo-cd/reconciler/`;
			if (!isText(sub) || !sub.startsWith(prefix))
				return agentRefusal(
					"svid-invalid",
					"SVID subject is not a delivery reconciler",
				);
			const jkt = isWireObject(cnf) ? cnf.jkt : undefined;
			if (!isText(jkt))
				return agentRefusal(
					"svid-invalid",
					"SVID is not key-bound (no cnf.jkt)",
				);
			return {
				ok: true,
				value: {
					reconcilerId: String(sub).slice(prefix.length),
					jkt: String(jkt),
				},
			};
		} catch (error) {
			const message = messageOf(error);
			return agentRefusal(
				/expired/u.test(message) ? "svid-expired" : "svid-invalid",
				message,
			);
		}
	}

	function stateRefusal(view: View): Refusal | undefined {
		if (view.record.enrollment === EnrollmentState.REVOKED)
			return agentRefusal(
				"reconciler-revoked",
				`${view.record.reconcilerId} was revoked`,
				view.record.reconcilerId,
			);
		if (view.record.enrollment !== EnrollmentState.ACCEPTED)
			return agentRefusal(
				ENROLLMENT_INCOMPLETE,
				`${view.record.reconcilerId} lacks ${view.record.keyApprovedBy ? "" : "reconciler.approve-key "}${view.record.acceptedBy ? "" : "reconciler.accept"}`.trim(),
				view.record.reconcilerId,
			);
		return undefined;
	}

	function refused<T>(outcome: Outcome<T>, metric: string): Outcome<T> {
		if (!outcome.ok) meter(metric, 1, { code: outcome.reasons[0]?.code ?? "" });
		return outcome;
	}

	// ── Port ─────────────────────────────────────────────────────────────
	const enrollment: AgentEnrollment = {
		async issueToken(input, ctx) {
			if (
				input.mode !== ReconcilerMode.AGENT &&
				input.mode !== ReconcilerMode.PUBLISHER
			)
				return agentRefusal(
					"mode-invalid",
					`mode ${ReconcilerMode[input.mode]} does not enroll`,
				);
			const ttlMs =
				input.ttlMs === 0 ? CD_DEFAULTS.bootstrapTokenTtlMs : input.ttlMs;
			if (
				!Number.isSafeInteger(ttlMs) ||
				ttlMs <= 0 ||
				ttlMs > CD_DEFAULTS.bootstrapTokenMaxTtlMs
			)
				return agentRefusal(
					"token-ttl-invalid",
					`ttl ${input.ttlMs} ms is outside 1 ms..24 h`,
				);
			const campIds = [...new Set(input.campIds)].sort();
			if (campIds.length === 0 || !input.campSet)
				return agentRefusal(
					"token-scope-invalid",
					"a token names a Camp set and at least one Camp",
				);
			const members = new Set<string>(
				(await d.inventory.list({ campSets: [input.campSet] })).map(
					(v) => v.topology.campId,
				),
			);
			const outside = campIds.filter((c) => !members.has(c));
			if (outside.length > 0)
				return agentRefusal(
					"token-scope-invalid",
					`Camps ${outside.join(", ")} are not in Camp set ${input.campSet}`,
					input.campSet,
				);
			const decision = await govern(
				"reconciler.enroll",
				{ campSet: input.campSet, campIds, mode: ReconcilerMode[input.mode] },
				ctx,
			);
			if (!decision.ok) return decision;
			const token = `${BOOTSTRAP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
			const expiresAtMs = ctx.now() + ttlMs;
			await store.append(
				AGENT_STREAMS.bootstrap(sha256Hex(token)),
				[
					event(AGENT_EVENTS.BootstrapTokenIssued, {
						campSet: input.campSet,
						campIds,
						mode: input.mode,
						expiresAt: iso(expiresAtMs),
						issuedBy: principalKey(ctx.principal),
						decisionId: decision.value,
					}),
				],
				{ expectedSeq: 0, actor: ctx.principal, tenant: d.tenant },
			);
			meter("hobo.cd.agent.tokens_issued", 1, { campSet: input.campSet });
			return { ok: true, value: { token, expiresAtMs } };
		},

		async enroll(input, ctx) {
			const result = await enrollOnce(input, ctx);
			meter(
				"hobo.cd.agent.enrollments",
				1,
				result.ok
					? { state: EnrollmentState[result.value.state] }
					: { refused: result.reasons[0]?.code ?? "" },
			);
			return result;
		},

		async approveKey(reconcilerId, ctx) {
			const result = await mutate(reconcilerId, ctx, async (view) => {
				if (view.record.keyApprovedBy) return { ok: true, value: [] };
				const by = principalKey(ctx.principal);
				if (
					view.record.acceptedBy === by &&
					(await separateApprovers(view.scopeCampIds))
				)
					return agentRefusal(
						"separate-approvers-required",
						`${by} already granted reconciler.accept`,
						reconcilerId,
					);
				const decision = await govern(
					"reconciler.approve-key",
					{
						reconcilerId,
						keyThumbprint: view.record.keyThumbprint,
						scope: view.record.bootstrapScope,
					},
					ctx,
				);
				if (!decision.ok) return decision;
				return {
					ok: true,
					value: [
						event(CD_EVENTS.ReconcilerKeyApproved, {
							by,
							decisionId: decision.value,
							at: iso(ctx.now()),
						}),
						...completion(
							view,
							by,
							view.record.acceptedBy,
							view.record.campIds,
						),
					],
				};
			});
			if (result.ok) meter("hobo.cd.agent.grants", 1, { grant: "approve-key" });
			return refused(result, "hobo.cd.agent.grant_refusals");
		},

		async accept(input, ctx) {
			const campIds = [...new Set<string>(input.campIds)].sort();
			const result = await mutate(input.reconcilerId, ctx, async (view) => {
				const outside = campIds.filter((c) => !view.scopeCampIds.includes(c));
				if (campIds.length === 0 || outside.length > 0)
					return agentRefusal(
						"camp-out-of-scope",
						`Camps ${outside.join(", ") || "(none)"} are outside bootstrap scope ${view.record.bootstrapScope}`,
						input.reconcilerId,
					);
				if (view.record.acceptedBy && sameList(view.record.campIds, campIds))
					return { ok: true, value: [] };
				const by = principalKey(ctx.principal);
				if (
					view.record.keyApprovedBy === by &&
					(await separateApprovers(view.scopeCampIds))
				)
					return agentRefusal(
						"separate-approvers-required",
						`${by} already granted reconciler.approve-key`,
						input.reconcilerId,
					);
				const decision = await govern(
					"reconciler.accept",
					{
						reconcilerId: input.reconcilerId,
						campIds,
						scope: view.record.bootstrapScope,
					},
					ctx,
				);
				if (!decision.ok) return decision;
				return {
					ok: true,
					value: [
						event(CD_EVENTS.ReconcilerAccepted, {
							by,
							decisionId: decision.value,
							campIds,
							autoAcceptScope: "",
							at: iso(ctx.now()),
						}),
						...(view.record.enrollment === EnrollmentState.ACCEPTED
							? []
							: completion(view, view.record.keyApprovedBy, by, campIds)),
					],
				};
			});
			if (result.ok) meter("hobo.cd.agent.grants", 1, { grant: "accept" });
			return refused(result, "hobo.cd.agent.grant_refusals");
		},

		async activate(input, ctx) {
			const view = await load(input.reconcilerId);
			if (!view)
				return refused(
					agentRefusal(
						"reconciler-unknown",
						`no enrollment for ${input.reconcilerId}`,
					),
					"hobo.cd.agent.verify_refusals",
				);
			const state = stateRefusal(view);
			if (state) return refused(state, "hobo.cd.agent.verify_refusals");
			const proof = await dpop.verify(input.dpopProof, {
				reconcilerId: view.record.reconcilerId,
				method: "POST",
				url: SVID_REFRESH_PATH,
				nowMs: ctx.now(),
			});
			if (!proof.ok) return refused(proof, "hobo.cd.agent.verify_refusals");
			if (proof.value.jkt !== view.record.keyThumbprint)
				return refused(
					agentRefusal(
						"dpop-key-mismatch",
						"the proof key is not the enrolled key",
						input.reconcilerId,
					),
					"hobo.cd.agent.verify_refusals",
				);
			const issued = await issueSvid(view, "activate", ctx);
			if (!issued.ok) return issued;
			const fresh = (await load(input.reconcilerId)) ?? view;
			return { ok: true, value: { reconciler: fresh.record, ...issued.value } };
		},

		async refresh(input, ctx) {
			const claims = await verifySvid(input.svid, ctx.now());
			const known = claims.ok
				? await load(claims.value.reconcilerId)
				: undefined;
			const fail = async (outcome: Refusal): Promise<Refusal> => {
				if (known && known.record.enrollment === EnrollmentState.ACCEPTED)
					await reportCredential(
						known,
						ConditionStatus.FALSE,
						"svid-refresh-failed",
					);
				else if (!claims.ok && claims.reasons[0]?.code === "svid-expired") {
					// Expiry is checked after the signature, so an expired SVID still names its reconciler authentically.
					const sub = unverifiedSubject(input.svid, trustDomain);
					const view = sub ? await load(sub) : undefined;
					if (view && view.record.enrollment === EnrollmentState.ACCEPTED)
						await reportCredential(
							view,
							ConditionStatus.FALSE,
							"svid-refresh-failed",
						);
				}
				meter("hobo.cd.agent.refresh_failures", 1, {
					code: outcome.reasons[0]?.code ?? "",
				});
				return outcome;
			};
			if (!claims.ok) return fail(claims);
			if (!known)
				return fail(
					agentRefusal("svid-invalid", "the SVID names no enrolled reconciler"),
				);
			const state = stateRefusal(known);
			if (state) return refused(state, "hobo.cd.agent.refresh_failures");
			const proof = await dpop.verify(input.dpopProof, {
				reconcilerId: known.record.reconcilerId,
				method: "POST",
				url: SVID_REFRESH_PATH,
				nowMs: ctx.now(),
				accessToken: input.svid,
			});
			if (!proof.ok) return fail(proof);
			if (
				proof.value.jkt !== claims.value.jkt ||
				proof.value.jkt !== known.record.keyThumbprint
			)
				return fail(
					agentRefusal(
						"dpop-key-mismatch",
						"the proof key is not the SVID's bound key",
					),
				);
			return issueSvid(known, "refresh", ctx);
		},

		async revoke(reconcilerId, reason, ctx) {
			const result = await mutate(reconcilerId, ctx, async () => {
				const decision = await govern(
					"reconciler.revoke",
					{ reconcilerId, reason },
					ctx,
				);
				if (!decision.ok) return decision;
				return {
					ok: true,
					value: [
						event(CD_EVENTS.ReconcilerRevoked, {
							by: principalKey(ctx.principal),
							reason,
							decisionId: decision.value,
							at: iso(ctx.now()),
						}),
					],
				};
			});
			if (result.ok) {
				meter("hobo.cd.agent.revocations", 1);
				const view = await load(reconcilerId);
				if (view)
					await reportCredential(
						view,
						ConditionStatus.FALSE,
						"reconciler-revoked",
					);
			}
			return result;
		},

		async verify(request: FeedRequest) {
			return refused(
				await verifyRequest(request),
				"hobo.cd.agent.verify_refusals",
			);
		},
	};

	async function verifyRequest(
		request: FeedRequest,
	): Promise<Outcome<ReconcilerRecord>> {
		const authorization = headerOf(request.headers, "authorization") ?? "";
		const match = /^DPoP\s+([A-Za-z0-9_.-]+)$/u.exec(authorization);
		if (!match?.[1])
			return agentRefusal(
				"svid-required",
				"send Authorization: DPoP <JWT-SVID>",
			);
		const svid = match[1];
		const proofHeader = headerOf(request.headers, "dpop");
		if (!proofHeader)
			return agentRefusal("dpop-required", "send a DPoP proof header");
		const nowMs = d.now();
		const claims = await verifySvid(svid, nowMs);
		if (!claims.ok) return claims;
		const view = await load(claims.value.reconcilerId);
		if (!view)
			return agentRefusal(
				"svid-invalid",
				"the SVID names no enrolled reconciler",
			);
		const state = stateRefusal(view);
		if (state) return state;
		const path = request.path.split("?")[0] ?? request.path;
		const host = headerOf(request.headers, "host");
		const url = d.publicOrigin
			? `${d.publicOrigin}${path}`
			: host
				? `https://${host}${path}`
				: path;
		const proof = await dpop.verify(proofHeader, {
			reconcilerId: view.record.reconcilerId,
			method: request.method,
			url,
			nowMs,
			accessToken: svid,
		});
		if (!proof.ok) return proof;
		if (
			proof.value.jkt !== claims.value.jkt ||
			proof.value.jkt !== view.record.keyThumbprint
		)
			return agentRefusal(
				"dpop-key-mismatch",
				"the proof key is not the SVID's bound key",
				view.record.reconcilerId,
			);
		return { ok: true, value: view.record };
	}

	async function enrollOnce(
		input: Readonly<{
			token: string;
			publicJwk: JsonObject;
			claims: readonly CampClaimRecord[];
		}>,
		ctx: CdContext,
	): Promise<
		Outcome<Readonly<{ reconciler: ReconcilerRecord; state: EnrollmentState }>>
	> {
		if (!input.token.startsWith(BOOTSTRAP_TOKEN_PREFIX))
			return agentRefusal("token-invalid", "not a bootstrap token");
		const jwk = parsePublicJwk(input.publicJwk);
		if (!jwk.ok) return jwk;
		const claims = parseClaims(input.claims);
		if (!claims.ok) return claims;
		const thumbprint = jwkThumbprint(jwk.value);
		const reconcilerId = reconcilerIdFor(thumbprint);
		const tokenHash = sha256Hex(input.token);
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const token = await loadToken(tokenHash);
			if (!token)
				return agentRefusal("token-invalid", "unknown bootstrap token");
			const existing = await load(reconcilerId);
			if (token.consumedBy !== undefined) {
				if (token.consumedBy !== thumbprint)
					return agentRefusal(
						"token-used",
						"the bootstrap token was already used",
					);
				if (existing)
					return {
						ok: true,
						value: {
							reconciler: existing.record,
							state: existing.record.enrollment,
						},
					};
			} else {
				if (ctx.now() > token.expiresAtMs)
					return agentRefusal(
						"token-expired",
						`the bootstrap token expired at ${iso(token.expiresAtMs)}`,
					);
				if (existing?.record.enrollment === EnrollmentState.REVOKED)
					return agentRefusal("key-revoked", "this key was revoked");
				if (existing)
					return agentRefusal(
						"key-already-enrolled",
						`key is enrolled as ${reconcilerId}`,
						reconcilerId,
					);
				const consumed = await append(
					AGENT_STREAMS.bootstrap(tokenHash),
					token.seq,
					[
						event(AGENT_EVENTS.BootstrapTokenConsumed, {
							thumbprint,
							reconcilerId,
							at: iso(ctx.now()),
						}),
					],
					ctx.principal,
				);
				if (!consumed) continue;
			}
			// Token consumed by this key; record the enrollment (idempotent recovery if a prior attempt stopped here).
			const auto = await autoAccepts(token.campSet, token.campIds);
			const record = create(ReconcilerRecordSchema, {
				reconcilerId,
				mode: token.mode,
				campIds: [...token.campIds],
				keyThumbprint: thumbprint,
				enrolledBy: `bootstrap:${token.campSet}`,
				enrolledAt: iso(ctx.now()),
				enrollment: EnrollmentState.PENDING,
				bootstrapScope: token.campSet,
			});
			const view: View = {
				seq: 0,
				record,
				jwk: jwk.value,
				scopeCampIds: token.campIds,
			};
			const autoBy = `rail-auto-accept:${token.campSet}`;
			const events: EventInput[] = [
				event(CD_EVENTS.ReconcilerEnrollmentRequested, {
					reconciler: recordJson(record),
					publicJwk: publicJwkJson(jwk.value),
					scopeCampIds: [...token.campIds],
					claims: claims.value.map((c) => toJson(CampClaimRecordSchema, c)),
					tokenHash,
				}),
				...(auto
					? [
							event(CD_EVENTS.ReconcilerKeyApproved, {
								by: autoBy,
								decisionId: "",
								at: iso(ctx.now()),
							}),
							event(CD_EVENTS.ReconcilerAccepted, {
								by: autoBy,
								decisionId: "",
								campIds: [...token.campIds],
								autoAcceptScope: token.campSet,
								at: iso(ctx.now()),
							}),
							...completion(view, autoBy, autoBy, token.campIds, token.campSet),
						]
					: []),
			];
			if (
				!(await append(
					CD_STREAMS.reconciler(reconcilerId),
					0,
					events,
					ctx.principal,
				))
			)
				continue;
			const fresh = await load(reconcilerId);
			if (!fresh)
				return agentRefusal(
					"store-unavailable",
					"enrollment vanished",
					reconcilerId,
				);
			return {
				ok: true,
				value: { reconciler: fresh.record, state: fresh.record.enrollment },
			};
		}
		return agentRefusal(
			"store-unavailable",
			"enrollment kept conflicting",
			reconcilerId,
		);
	}

	return Object.freeze(enrollment);
}

function parseClaims(
	claims: readonly CampClaimRecord[],
): Outcome<readonly CampClaimRecord[]> {
	const names = new Set<string>();
	for (const claim of claims) {
		if (!claim.name || !claim.value || names.has(claim.name))
			return agentRefusal(
				"claim-invalid",
				`claim ${claim.name || "(unnamed)"} is invalid`,
			);
		names.add(claim.name);
	}
	return {
		ok: true,
		value: claims.map((c) =>
			create(CampClaimRecordSchema, {
				name: c.name,
				value: c.value,
				reportedBy: c.reportedBy,
				observedAt: c.observedAt,
			}),
		),
	};
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return (
		a.length === b.length &&
		[...a].sort().every((v, i) => v === [...b].sort()[i])
	);
}

function unverifiedSubject(
	svid: string,
	trustDomain: string,
): string | undefined {
	try {
		const claims: PbJsonValue = JSON.parse(
			Buffer.from(svid.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		const prefix = `spiffe://${trustDomain}/hobo-cd/reconciler/`;
		const sub = isWireObject(claims) ? claims.sub : undefined;
		return isText(sub) && sub.startsWith(prefix)
			? String(sub).slice(prefix.length)
			: undefined;
	} catch {
		return undefined;
	}
}

function defaultIssuer(tenant: string): JwtSvidIssuer {
	const kms = createInMemoryKms();
	kms.generateRsaKey("cd-feed-svid-1");
	return new JwtSvidIssuer({
		issuerUrl: `https://cd.hobo.invalid/${tenant}`,
		kms,
		activeKeyId: "cd-feed-svid-1",
		jwksKeyIds: ["cd-feed-svid-1"],
	});
}

export type { AgentFailureCode };
