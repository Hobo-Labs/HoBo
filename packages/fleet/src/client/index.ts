/**
 * `@hobo/fleet/client` (L07): the typed HTTP client of the authority's API,
 * one method per non-browser route of `FleetApi` (design §6.15, §7.3).
 *
 * Bodies are protobuf JSON of the named record; errors come back as the §7.6
 * `FleetFailure`; every authenticated call carries a DPoP proof made with
 * `auth.signer` (see ./http.ts for which routes take a token, a bare proof or
 * nothing). Nothing here throws across the port.
 */
import {
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	AuthorityDiscoverySchema,
	CredentialRequestSchema,
	CredentialResponseSchema,
	DeclareRequestSchema,
	DiscoverySchema,
	EnrollmentRequestSchema,
	EnrollmentResponseSchema,
	FleetListSchema,
	FleetRecordSchema,
	FleetVerdictSchema,
	KeyRotationRequestSchema,
	LifecycleRequestSchema,
	MemberListSchema,
	MembershipRequestSchema,
	PersonCredentialSchema,
	SessionRequestSchema,
	SignedEnvelopeSchema,
	SignInChallengeSchema,
	SignInCompleteSchema,
	SignInPollSchema,
	SignInRefreshSchema,
	SignInStartSchema,
	TokenCreateRequestSchema,
	TokenCreateResponseSchema,
	TokenListSchema,
	ViolationReportSchema,
	WorkLogsSchema,
	WorkStatusSchema,
	WorkSubmissionRequestSchema,
} from "../_generated/fleet_pb.js";
import type {
	FleetApi,
	FleetClient,
	Outcome,
	PublicJwk,
	Signer,
} from "../ports.js";
import {
	type AuthKind,
	body,
	type ClientAuth,
	type HttpMethod,
	query,
	record,
	segment,
	send,
	type Wire,
} from "./http.js";

const MEMBERS = "/v1/fleet/members";
const FLEETS = "/v1/fleet/fleets";
const WORK = "/v1/fleet/work";
const TOKENS = "/v1/fleet/tokens";

type LifecycleMethod =
	| "approveKey"
	| "accept"
	| "reject"
	| "suspend"
	| "resume"
	| "unlock"
	| "revoke";

/** The path suffix of each lifecycle route (§6.15). */
const LIFECYCLE_PATHS = {
	approveKey: "approve-key",
	accept: "accept",
	reject: "reject",
	suspend: "suspend",
	resume: "resume",
	unlock: "unlock",
	revoke: "revoke",
};

export function createFleetClient(
	options: Readonly<{
		origin: string;
		fetch: typeof fetch;
		auth:
			| Readonly<{
					token(): Promise<string>;
					signer: Signer;
					publicJwk: PublicJwk;
			  }>
			| undefined;
	}>,
): FleetClient {
	const auth: ClientAuth | undefined = options.auth;
	const wire: Wire = { origin: options.origin, fetch: options.fetch, auth };
	const envelope = record(SignedEnvelopeSchema);

	function call<T>(
		method: HttpMethod,
		path: string,
		kind: AuthKind,
		parse: (text: string) => T,
		payload?: string,
	): Promise<Outcome<T>> {
		return send(
			wire,
			payload === undefined
				? { method, path, auth: kind, parse }
				: { method, path, auth: kind, parse, body: payload },
		);
	}

	const lifecycle =
		(method: LifecycleMethod) => (request: FleetApi[LifecycleMethod][0]) =>
			call(
				"POST",
				`${MEMBERS}/${segment(request.memberId)}/${LIFECYCLE_PATHS[method]}`,
				"token",
				envelope,
				body(LifecycleRequestSchema, request.request),
			);

	return {
		authorityDiscovery: () =>
			call(
				"GET",
				"/.well-known/hobo-fleet",
				"none",
				record(AuthorityDiscoverySchema),
			),
		discovery: (request) =>
			call(
				"GET",
				`/v1/fleet/tenants/${segment(request.tenant)}/discovery`,
				"none",
				record(DiscoverySchema),
			),
		jwks: () =>
			call("GET", "/v1/fleet/jwks", "none", (text) => ({ jwks: text })),
		signInStart: (request) =>
			call(
				"POST",
				"/v1/fleet/signin/start",
				"none",
				record(SignInChallengeSchema),
				body(SignInStartSchema, request),
			),
		signInComplete: (request) =>
			call(
				"POST",
				"/v1/fleet/signin/complete",
				"proof",
				record(PersonCredentialSchema),
				body(SignInCompleteSchema, request),
			),
		signInPoll: (request) =>
			call(
				"POST",
				"/v1/fleet/signin/device/poll",
				"proof",
				record(PersonCredentialSchema),
				body(SignInPollSchema, request),
			),
		signInRefresh: (request) =>
			call(
				"POST",
				"/v1/fleet/signin/refresh",
				"token",
				record(PersonCredentialSchema),
				body(SignInRefreshSchema, request),
			),
		issueToken: (request) =>
			call(
				"POST",
				TOKENS,
				"token",
				record(TokenCreateResponseSchema),
				body(TokenCreateRequestSchema, request),
			),
		listTokens: () => call("GET", TOKENS, "token", record(TokenListSchema)),
		revokeToken: (request) =>
			call(
				"DELETE",
				`${TOKENS}/${segment(request.tokenHash)}`,
				"token",
				record(TokenListSchema),
			),
		enroll: (request) =>
			call(
				"POST",
				MEMBERS,
				"proof",
				record(EnrollmentResponseSchema),
				body(EnrollmentRequestSchema, request),
			),
		declare: (request) =>
			call(
				"POST",
				`${MEMBERS}:declare`,
				"token",
				record(EnrollmentResponseSchema),
				body(DeclareRequestSchema, request),
			),
		approveKey: lifecycle("approveKey"),
		accept: lifecycle("accept"),
		reject: lifecycle("reject"),
		suspend: lifecycle("suspend"),
		resume: lifecycle("resume"),
		unlock: lifecycle("unlock"),
		revoke: lifecycle("revoke"),
		assign: (request) =>
			call(
				"POST",
				`${MEMBERS}/${segment(request.memberId)}/memberships`,
				"token",
				envelope,
				body(MembershipRequestSchema, request.request),
			),
		credentials: (request) =>
			call(
				"POST",
				`${MEMBERS}/${segment(request.memberId)}/credentials`,
				"proof",
				record(CredentialResponseSchema),
				body(CredentialRequestSchema, request.request),
			),
		rotateKeys: (request) =>
			call(
				"POST",
				`${MEMBERS}/${segment(request.memberId)}/keys`,
				"token",
				envelope,
				body(KeyRotationRequestSchema, request.request),
			),
		leave: (request) =>
			call(
				"POST",
				`${MEMBERS}/${segment(request.memberId)}/leave`,
				"token",
				envelope,
			),
		listMembers: (request) =>
			call(
				"GET",
				`${MEMBERS}${query([["fleet", request.fleet]])}`,
				"token",
				record(MemberListSchema),
			),
		getMember: (request) =>
			call("GET", `${MEMBERS}/${segment(request.memberId)}`, "token", envelope),
		listFleets: () => call("GET", FLEETS, "token", record(FleetListSchema)),
		getFleet: (request) =>
			call("GET", `${FLEETS}/${segment(request.fleetId)}`, "token", envelope),
		defineFleet: (request) =>
			call(
				"PUT",
				`${FLEETS}/${segment(request.fleetId)}`,
				"token",
				envelope,
				body(FleetRecordSchema, request),
			),
		fleetView: (request) =>
			call(
				"GET",
				`${FLEETS}/${segment(request.fleetId)}/view`,
				"token",
				envelope,
			),
		fleetVerdict: (request) =>
			call(
				"GET",
				`${FLEETS}/${segment(request.fleetId)}/verdict${query([["label", request.label]])}`,
				"token",
				record(FleetVerdictSchema),
			),
		grantSession: (request) =>
			call(
				"POST",
				"/v1/fleet/sessions",
				"token",
				envelope,
				body(SessionRequestSchema, request),
			),
		submitWork: (request) =>
			call(
				"POST",
				WORK,
				"token",
				record(WorkStatusSchema),
				body(WorkSubmissionRequestSchema, request),
			),
		workStatus: (request) =>
			call(
				"GET",
				`${WORK}/${segment(request.submissionId)}`,
				"token",
				record(WorkStatusSchema),
			),
		workLogs: (request) =>
			call(
				"GET",
				`${WORK}/${segment(request.submissionId)}/logs`,
				"token",
				record(WorkLogsSchema),
			),
		report: (request) =>
			call(
				"POST",
				"/v1/fleet/reports",
				"token",
				envelope,
				body(ViolationReportSchema, request),
			),
		auditCheckpoints: (request) =>
			call(
				"GET",
				`/v1/fleet/audit/checkpoints${query([["from", request.fromSequence]])}`,
				"token",
				record(AuditCheckpointsSchema),
			),
		auditEntries: (request) =>
			call(
				"GET",
				`/v1/fleet/audit/entries${query([
					["from", request.from],
					["to", request.to],
				])}`,
				"token",
				record(AuditEntriesSchema),
			),
	};
}
