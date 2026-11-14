// Agent enrollment over the fleet (L19; D5, D19, I3, I24). A reconciler is a
// fleet DEVICE with role RECONCILER in the fleet named after its Yard: the
// fleet holds its identity (the `hft_` bootstrap token, the key, the member
// SVID, DPoP and replay, revocation). This adapter keeps what is delivery
// policy: the Camp-set scope of a token, the two grants with Rail rules
// (separate approvers, auto-accept scopes), governance through the delivery
// authorizer, and the accepted Camps. Its journal is an actor per reconciler
// on `cd-reconciler-<memberId>` and a token scope on `cd-bootstrap-<sha256>`;
// every command catches up from the journal and appends with expectedSeq.
//
//   issueToken  governed `reconciler.enroll`; a fleet token (TokenCreateRequest,
//               role RECONCILER) and its Camp scope (hash only).
//   enroll      the agent's EnrollmentRequest and DPoP proof, forwarded to the
//               fleet; PENDING unless every governing Rail auto-accepts.
//   approveKey  grant 1, governed `reconciler.approve-key`.
//   accept      grant 2, governed `reconciler.accept`; once both grants are
//               held the Station approves and accepts the fleet member.
//   refresh     the fleet `credentials` call with the agent's proof.
//   revoke      governed `reconciler.revoke`; the fleet member is revoked, so
//               the next request is refused by the fleet's `authenticate`.
//   verify      the fleet's `authenticate` (member SVID and DPoP proof), then
//               the delivery grants.
import { createHash, randomBytes } from "node:crypto";
import {
	create,
	fromBinary,
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
	DeviceClass,
	type FleetFailure,
	LifecycleRequestSchema,
	type MemberRecord,
	MemberRecordSchema,
	Role,
	TokenCreateRequestSchema,
} from "@hobo/fleet";
import {
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
	isWireObject,
	text,
	texts,
	type WireObject,
} from "../feed/json.js";
import { campMemberName } from "../inventory/inventory.js";
import type {
	AgentEnrollment,
	CampId,
	CampInventory,
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	DeliveryFleet,
	FeedRequest,
	Outcome,
	RailDeliveryReader,
	Refusal,
	TelemetrySink,
} from "../ports.js";
import { type AgentFailureCode, agentRefusal } from "./errors.js";
import { AGENT_EVENT_SCHEMA, AGENT_EVENTS, AGENT_STREAMS } from "./events.js";
import { createMeter } from "./metrics.js";

// public-contract: path of member SVID refresh on the delivery feed (the fleet `credentials` call, forwarded).
export const SVID_REFRESH_PATH = "/v1/cd/svid/refresh" as const;
// public-contract: bootstrap token prefix (the fleet's).
export const BOOTSTRAP_TOKEN_PREFIX = "hft_" as const;

export type AgentEnrollmentDeps = CdBase & {
	readonly authorizer: CdAuthorizer;
	readonly rails: RailDeliveryReader;
	readonly inventory: CampInventory;
	/** The fleet the reconcilers join; absent: every identity step refuses (`fleet-unavailable`). */
	readonly fleet?: DeliveryFleet | undefined;
	readonly telemetry?: TelemetrySink;
	/** The Station's public origin (`https://station.example`); the `htu` of feed proofs. */
	readonly publicOrigin?: string;
};

type View = {
	seq: number;
	record: ReconcilerRecord;
	scopeCampIds: readonly string[];
};

type TokenView = Readonly<{
	campSet: string;
	campIds: readonly string[];
	mode: ReconcilerMode;
	expiresAtMs: number;
}>;

const STATION: PrincipalRef = { kind: "service", id: "cd-station" };
const MAX_ATTEMPTS = 8;
const FLEET_TOKEN_MIN_S = 600;
const FLEET_TOKEN_MAX_S = 1_800;

function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

/** The delivery refusal code of the fleet failures that have one. */
const FLEET_CODES: ReadonlyMap<string, AgentFailureCode> = new Map([
	["token-invalid", "token-invalid"],
	["token-used", "token-used"],
	["token-expired", "token-expired"],
	["key-known", "key-already-enrolled"],
	["proof-invalid", "dpop-invalid"],
	["proof-replayed", "dpop-replayed"],
	["member-revoked", "reconciler-revoked"],
]);

/** A fleet failure as a delivery refusal: the fleet's code and message are kept in the message. */
function fleetRefusal(
	fallback: AgentFailureCode,
	failure: FleetFailure,
	subject = "",
): Refusal {
	return agentRefusal(
		FLEET_CODES.get(failure.code) ?? fallback,
		`fleet ${failure.code}: ${failure.message}`,
		subject,
	);
}

export function createAgentEnrollment(d: AgentEnrollmentDeps): AgentEnrollment {
	const store: DurableEventStore = d.store;
	const meter = createMeter(d.telemetry, d.now);
	const cache = new Map<string, View>();

	// ── Folds ────────────────────────────────────────────────────────────
	async function load(reconcilerId: string): Promise<View | undefined> {
		const stream = CD_STREAMS.reconciler(reconcilerId);
		let view = cache.get(reconcilerId);
		for await (const event of store.read(stream, (view?.seq ?? 0) + 1)) {
			const data = bodyOf(event.data);
			if (event.type === CD_EVENTS.ReconcilerEnrollmentRequested) {
				view = {
					seq: event.seq,
					record: fromJson(ReconcilerRecordSchema, data.reconciler ?? {}, {
						ignoreUnknownFields: true,
					}),
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
					campSet: str(data.campSet),
					campIds: texts(data.campIds),
					mode: isNumber(data.mode) ? data.mode : ReconcilerMode.UNSPECIFIED,
					expiresAtMs: Date.parse(str(data.expiresAt)),
				};
		}
		return token;
	}

	// ── Helpers ──────────────────────────────────────────────────────────
	function fleetOrRefuse(): Outcome<DeliveryFleet> {
		return d.fleet === undefined
			? agentRefusal(
					"fleet-unavailable",
					"this Station has no fleet authority configured",
				)
			: { ok: true, value: d.fleet };
	}

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
		campIds: readonly string[],
		status: ConditionStatus,
		reason: string,
	): Promise<void> {
		const ctx: CdContext = { tenant: d.tenant, principal: STATION, now: d.now };
		for (const campId of campIds) {
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

	/**
	 * Once both delivery grants are held, the Station approves the member's
	 * key and accepts it into the Yard's fleet (approve-key before accept, as
	 * the fleet requires). Both calls are idempotent at the fleet.
	 */
	async function activateMember(
		fleet: DeliveryFleet,
		memberId: string,
		reason: string,
	): Promise<Outcome<true>> {
		const request = create(LifecycleRequestSchema, {
			reason,
			fleets: [fleet.fleet],
		});
		const approved = await fleet.station.approveKey({ memberId, request });
		if (!approved.ok)
			return fleetRefusal("fleet-refused", approved.error, memberId);
		const accepted = await fleet.station.accept({ memberId, request });
		if (!accepted.ok)
			return fleetRefusal("fleet-refused", accepted.error, memberId);
		return { ok: true, value: true };
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

	/** The completing event when both grants are held; the fleet member is activated first. */
	async function completion(
		view: View,
		keyApprovedBy: string,
		acceptedBy: string,
		campIds: readonly string[],
		autoScope = "",
	): Promise<Outcome<EventInput[]>> {
		if (!keyApprovedBy || !acceptedBy) return { ok: true, value: [] };
		const fleet = fleetOrRefuse();
		if (!fleet.ok) return fleet;
		const activated = await activateMember(
			fleet.value,
			view.record.reconcilerId,
			autoScope ? `rail-auto-accept:${autoScope}` : "delivery grants held",
		);
		if (!activated.ok) return activated;
		const record = create(ReconcilerRecordSchema, {
			...view.record,
			keyApprovedBy,
			acceptedBy,
			campIds: [...campIds],
			enrollment: EnrollmentState.ACCEPTED,
			autoAcceptedByScope: autoScope || view.record.autoAcceptedByScope,
		});
		return {
			ok: true,
			value: [
				event(CD_EVENTS.ReconcilerEnrolled, { reconciler: recordJson(record) }),
			],
		};
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

	function feedUrl(request: FeedRequest): string {
		const path = request.path.split("?")[0] ?? request.path;
		const host = headerOf(request.headers, "host");
		return d.publicOrigin
			? `${d.publicOrigin}${path}`
			: host
				? `https://${host}${path}`
				: path;
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
			const fleet = fleetOrRefuse();
			if (!fleet.ok) return fleet;
			const decision = await govern(
				"reconciler.enroll",
				{ campSet: input.campSet, campIds, mode: ReconcilerMode[input.mode] },
				ctx,
			);
			if (!decision.ok) return decision;
			// The fleet bounds a bootstrap token to 10..30 minutes (TokenCreateRequest).
			const ttlSeconds = Math.min(
				FLEET_TOKEN_MAX_S,
				Math.max(FLEET_TOKEN_MIN_S, Math.ceil(ttlMs / 1000)),
			);
			// A reconciler of one Camp is named after it, so the Camp mapper finds
			// the DEVICE backing that Camp; any other is named after its Camp set.
			const only = campIds.length === 1 ? campIds[0] : undefined;
			const token = (name: string) =>
				fleet.value.station.issueToken(
					create(TokenCreateRequestSchema, {
						fleet: fleet.value.fleet,
						name,
						displayName: `reconciler for ${input.campSet}`,
						deviceClass: DeviceClass.DEDICATED,
						roles: [Role.RECONCILER],
						ttlSeconds,
					}),
				);
			const setName = (): string =>
				`${campMemberName(input.campSet).slice(0, 52)}-${randomBytes(5).toString("hex")}`;
			let issued = await token(
				only === undefined ? setName() : campMemberName(only),
			);
			if (!issued.ok && issued.error.code === "name-taken")
				issued = await token(setName());
			if (!issued.ok) return fleetRefusal("fleet-refused", issued.error);
			const expiresAtMs = ctx.now() + ttlSeconds * 1000;
			const tokenHash = issued.value.tokenHash || sha256Hex(issued.value.token);
			await store.append(
				AGENT_STREAMS.bootstrap(tokenHash),
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
			return { ok: true, value: { token: issued.value.token, expiresAtMs } };
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
				const done = await completion(
					view,
					by,
					view.record.acceptedBy,
					view.record.campIds,
				);
				if (!done.ok) return done;
				return {
					ok: true,
					value: [
						event(CD_EVENTS.ReconcilerKeyApproved, {
							by,
							decisionId: decision.value,
							at: iso(ctx.now()),
						}),
						...done.value,
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
				const done =
					view.record.enrollment === EnrollmentState.ACCEPTED
						? { ok: true as const, value: [] }
						: await completion(view, view.record.keyApprovedBy, by, campIds);
				if (!done.ok) return done;
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
						...done.value,
					],
				};
			});
			if (result.ok) meter("hobo.cd.agent.grants", 1, { grant: "accept" });
			return refused(result, "hobo.cd.agent.grant_refusals");
		},

		async refresh(input, _ctx) {
			const fleet = fleetOrRefuse();
			if (!fleet.ok) return fleet;
			const view = await load(input.memberId);
			if (!view)
				return agentRefusal(
					"reconciler-unknown",
					`no enrollment for ${input.memberId}`,
					input.memberId,
				);
			const state = stateRefusal(view);
			if (state) return refused(state, "hobo.cd.agent.refresh_refusals");
			const issued = await fleet.value
				.forward(input.dpopProof)
				.credentials({ memberId: input.memberId, request: input.request });
			if (!issued.ok) {
				await reportCredential(
					view.record.campIds,
					ConditionStatus.FALSE,
					"svid-refresh-failed",
				);
				return refused(
					fleetRefusal("svid-invalid", issued.error, input.memberId),
					"hobo.cd.agent.refresh_refusals",
				);
			}
			meter("hobo.cd.agent.svids_issued", 1, { kind: "refresh" });
			await reportCredential(
				view.record.campIds,
				ConditionStatus.TRUE,
				`expires-at:${issued.value.svidExpiresAt}`,
			);
			return { ok: true, value: issued.value };
		},

		async revoke(reconcilerId, reason, ctx) {
			const result = await mutate(reconcilerId, ctx, async () => {
				const decision = await govern(
					"reconciler.revoke",
					{ reconcilerId, reason },
					ctx,
				);
				if (!decision.ok) return decision;
				const fleet = fleetOrRefuse();
				if (!fleet.ok) return fleet;
				const revoked = await fleet.value.station.revoke({
					memberId: reconcilerId,
					request: create(LifecycleRequestSchema, { reason }),
				});
				if (!revoked.ok)
					return fleetRefusal("fleet-refused", revoked.error, reconcilerId);
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
				await reportCredential(
					result.value.campIds,
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
		if (!/^DPoP\s+\S+$/u.test(authorization))
			return agentRefusal(
				"svid-required",
				"send Authorization: DPoP <member SVID>",
			);
		const dpop = headerOf(request.headers, "dpop");
		if (!dpop) return agentRefusal("dpop-required", "send a DPoP proof header");
		const fleet = fleetOrRefuse();
		if (!fleet.ok) return fleet;
		const caller = await fleet.value.authenticate({
			method: request.method,
			url: feedUrl(request),
			authorization,
			dpop,
		});
		if (!caller.ok) return fleetRefusal("svid-invalid", caller.error);
		if (caller.value.kind !== "member")
			return agentRefusal(
				"svid-invalid",
				"the credential is not a fleet member SVID",
			);
		const view = await load(caller.value.memberId);
		if (!view)
			return agentRefusal(
				"svid-invalid",
				"the SVID names no enrolled reconciler",
			);
		const state = stateRefusal(view);
		if (state) return state;
		return { ok: true, value: view.record };
	}

	async function enrollOnce(
		input: Parameters<AgentEnrollment["enroll"]>[0],
		ctx: CdContext,
	): Promise<
		Outcome<Readonly<{ reconciler: ReconcilerRecord; state: EnrollmentState }>>
	> {
		const proof = input.request.proof;
		if (
			proof.case !== "bootstrapToken" ||
			!proof.value.startsWith(BOOTSTRAP_TOKEN_PREFIX)
		)
			return agentRefusal("token-invalid", "not a fleet bootstrap token");
		const fleet = fleetOrRefuse();
		if (!fleet.ok) return fleet;
		if (input.request.fleet !== fleet.value.fleet)
			return agentRefusal(
				"token-scope-invalid",
				`the request names fleet ${input.request.fleet}, not ${fleet.value.fleet}`,
			);
		const token = await loadToken(sha256Hex(proof.value));
		if (!token) return agentRefusal("token-invalid", "unknown bootstrap token");
		if (ctx.now() > token.expiresAtMs)
			return agentRefusal(
				"token-expired",
				`the bootstrap token expired at ${iso(token.expiresAtMs)}`,
			);
		const requested = [...new Set<string>(input.campIds)].sort();
		const outside = requested.filter((c) => !token.campIds.includes(c));
		if (outside.length > 0)
			return agentRefusal(
				"camp-out-of-scope",
				`Camps ${outside.join(", ")} are outside bootstrap scope ${token.campSet}`,
			);
		const campIds = requested.length > 0 ? requested : [...token.campIds];

		const enrolled = await fleet.value
			.forward(input.dpopProof)
			.enroll(input.request);
		if (!enrolled.ok) return fleetRefusal("fleet-refused", enrolled.error);
		const envelope = enrolled.value.memberRecord;
		let member: MemberRecord;
		try {
			if (envelope === undefined) throw new Error("no member record");
			member = fromBinary(MemberRecordSchema, envelope.payload);
		} catch {
			return agentRefusal(
				"response-invalid",
				"the fleet answered no member record",
			);
		}
		const reconcilerId = member.memberId;

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const existing = await load(reconcilerId);
			if (existing)
				return {
					ok: true,
					value: {
						reconciler: existing.record,
						state: existing.record.enrollment,
					},
				};
			const auto = await autoAccepts(token.campSet, campIds);
			const record = create(ReconcilerRecordSchema, {
				reconcilerId,
				mode: token.mode,
				campIds,
				keyThumbprint: member.identityThumbprint,
				enrolledBy: `bootstrap:${token.campSet}`,
				enrolledAt: iso(ctx.now()),
				enrollment: EnrollmentState.PENDING,
				bootstrapScope: token.campSet,
			});
			const view: View = { seq: 0, record, scopeCampIds: token.campIds };
			const autoBy = `rail-auto-accept:${token.campSet}`;
			let completed: EventInput[] = [];
			if (auto) {
				const done = await completion(
					view,
					autoBy,
					autoBy,
					campIds,
					token.campSet,
				);
				if (!done.ok) return done;
				completed = done.value;
			}
			const events: EventInput[] = [
				event(CD_EVENTS.ReconcilerEnrollmentRequested, {
					reconciler: recordJson(record),
					scopeCampIds: [...token.campIds],
					memberId: reconcilerId,
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
								campIds,
								autoAcceptScope: token.campSet,
								at: iso(ctx.now()),
							}),
							...completed,
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

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return (
		a.length === b.length &&
		[...a].sort().every((v, i) => v === [...b].sort()[i])
	);
}

export type { AgentFailureCode };
