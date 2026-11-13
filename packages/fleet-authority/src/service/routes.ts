/**
 * The route table of design §6.15: every route is exactly one `FleetApi`
 * method, with the auth modes its Auth column allows, how its request is
 * built from the path, query and protobuf JSON body, and how its response is
 * written. The service (`http.ts`) maps routes to methods and nothing else.
 */
import {
	type DescMessage,
	fromJsonString,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import {
	ApprovalDecisionSchema,
	ApprovalResultSchema,
	ApprovalViewSchema,
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	AuthorityDiscoverySchema,
	CredentialRequestSchema,
	CredentialResponseSchema,
	DeclareRequestSchema,
	DiscoverySchema,
	EnrollmentRequestSchema,
	EnrollmentResponseSchema,
	type FleetApi,
	type FleetFailure,
	FleetListSchema,
	FleetRecordSchema,
	FleetVerdictSchema,
	KeyRotationRequestSchema,
	LifecycleRequestSchema,
	MemberListSchema,
	MembershipRequestSchema,
	type Outcome,
	PersonCredentialSchema,
	parseFleetId,
	SessionRequestSchema,
	SignedEnvelopeSchema,
	SignInCallbackSchema,
	SignInChallengeSchema,
	SignInCompleteSchema,
	SignInDeviceCodeSchema,
	SignInPollSchema,
	SignInRefreshSchema,
	SignInStartSchema,
	TokenCreateRequestSchema,
	TokenCreateResponseSchema,
	TokenListSchema,
	type VerifiedToken,
	ViolationReportSchema,
	WorkLogsSchema,
	WorkStatusSchema,
	WorkSubmissionRequestSchema,
} from "@hobo/fleet";
import type { AuthorityRuntime } from "../compose/assemble.js";

/** The record a schema describes. */
type RecordOf<D extends DescMessage> = ReturnType<typeof fromJsonString<D>>;

export type CallerKind = VerifiedToken["kind"];

/**
 * How a route admits its caller (§6.15 Auth column):
 * - `none`: anyone; credentials are not read.
 * - `browser`: the browser session the sign-in callback set (a cookie).
 * - `signin-key`: a DPoP proof with the CLI's sign-in key, checked by sign-in.
 * - `identity-key`: a DPoP proof with the request's identity key; the proof
 *   in the body (token, person token, assertion) is checked by enrollment.
 * - a list: an authenticated caller of one of these kinds.
 */
export type RouteAuth =
	| "none"
	| "browser"
	| "signin-key"
	| "identity-key"
	| readonly CallerKind[];

export type RouteInput = Readonly<{
	params: Readonly<Record<string, string>>;
	query: URLSearchParams;
	/** The body as text; empty for GET and DELETE. */
	body: string;
	/** True when the body is an HTML form rather than protobuf JSON. */
	form: boolean;
}>;

export type CallContext = Readonly<{
	runtime: AuthorityRuntime;
	caller: VerifiedToken | undefined;
	dpop: string;
}>;

export type Route = Readonly<{
	method: "GET" | "POST" | "PUT" | "DELETE";
	/** Segments; `{name}` captures one segment. */
	path: string;
	api: keyof FleetApi;
	auth: RouteAuth;
	/** Builds the request and calls the method; the response as JSON. */
	run(context: CallContext, input: RouteInput): Promise<Outcome<JsonValue>>;
}>;

function invalid<T>(message: string): Outcome<T> {
	const error: FleetFailure = { code: "invalid-request", message };
	return { ok: false, error };
}

/** Protobuf JSON into a record; unknown fields refused. */
function parseBody<D extends DescMessage>(
	schema: D,
	text: string,
): Outcome<RecordOf<D>> {
	try {
		return {
			ok: true,
			value: fromJsonString(schema, text.length === 0 ? "{}" : text),
		};
	} catch (error) {
		return invalid(
			`the body is not a ${schema.typeName}: ${error instanceof Error ? error.message : "parse error"}`,
		);
	}
}

function encoded<D extends DescMessage>(
	schema: D,
	outcome: Outcome<RecordOf<D>>,
): Outcome<JsonValue> {
	return outcome.ok
		? { ok: true, value: toJson(schema, outcome.value) }
		: outcome;
}

type Request<M extends keyof FleetApi> = FleetApi[M][0];
type Response<M extends keyof FleetApi> = FleetApi[M][1];

/** The one method of the route, as `EnrollmentAuthority` types it. */
function callMethod<M extends keyof FleetApi>(
	context: CallContext,
	api: M,
	request: Request<M>,
): Promise<Outcome<Response<M>>> {
	// SAFETY: EnrollmentAuthority maps every FleetApi key M to (FleetApi[M][0], caller) => Outcome<FleetApi[M][1]>; TypeScript cannot correlate M across the union.
	const method = context.runtime.authority[api] as (
		request: Request<M>,
		caller: VerifiedToken | undefined,
	) => Promise<Outcome<Response<M>>>;
	return method(request, context.caller);
}

/** A route whose request comes from `build` and whose method is called as is. */
function route<M extends keyof FleetApi, D extends DescMessage>(
	method: Route["method"],
	path: string,
	api: M,
	auth: RouteAuth,
	response: D,
	build: (input: RouteInput) => Outcome<Request<M>>,
	call?: (
		context: CallContext,
		request: Request<M>,
	) => Promise<Outcome<Response<M>>>,
): Route {
	return {
		method,
		path,
		api,
		auth,
		async run(context, input) {
			const request = build(input);
			if (!request.ok) return request;
			const outcome =
				call === undefined
					? await callMethod(context, api, request.value)
					: await call(context, request.value);
			// SAFETY: FleetApi[M][1] is the record `response` describes, as the table below pairs them.
			return encoded(response, outcome as Outcome<RecordOf<D>>);
		},
	};
}

const empty = (): Outcome<Readonly<Record<string, never>>> => ({
	ok: true,
	value: {},
});

function param(input: RouteInput, name: string): Outcome<string> {
	const value = input.params[name] ?? "";
	return value.length === 0 || value.length > 256
		? invalid(`the path ${name} is missing or too long`)
		: { ok: true, value };
}

function byId<K extends string>(
	name: K,
	input: RouteInput,
	from = "id",
): Outcome<Readonly<Record<K, string>>> {
	const id = param(input, from);
	if (!id.ok) return id;
	const value = Object.fromEntries([[name, id.value]]);
	// SAFETY: a one-key record built from the key it is typed by.
	return { ok: true, value: value as Readonly<Record<K, string>> };
}

function withBody<K extends string, D extends DescMessage>(
	name: K,
	schema: D,
	input: RouteInput,
): Outcome<Readonly<Record<K, string>> & { request: RecordOf<D> }> {
	const id = byId(name, input);
	if (!id.ok) return id;
	const body = parseBody(schema, input.body);
	if (!body.ok) return body;
	return { ok: true, value: { ...id.value, request: body.value } };
}

function integer(
	text: string | null,
	name: string,
): Outcome<number | undefined> {
	if (text === null || text.length === 0) return { ok: true, value: undefined };
	if (!/^\d{1,15}$/u.test(text))
		return invalid(`${name} is not a whole number`);
	return { ok: true, value: Number(text) };
}

/** Lifecycle routes: `POST /v1/fleet/members/{id}/<verb>` with a `LifecycleRequest`. */
function lifecycle(
	verb: string,
	api:
		| "approveKey"
		| "accept"
		| "reject"
		| "suspend"
		| "resume"
		| "unlock"
		| "revoke",
): Route {
	return route(
		"POST",
		`/v1/fleet/members/{id}/${verb}`,
		api,
		["person"],
		SignedEnvelopeSchema,
		(input) => withBody("memberId", LifecycleRequestSchema, input),
	);
}

const READ: readonly CallerKind[] = ["person", "member", "account"];

// public-contract: the HTTP routes of design §6.15; clients (L07) and the deployment (L23) address them.
export const ROUTES: readonly Route[] = [
	route(
		"GET",
		"/.well-known/hobo-fleet",
		"authorityDiscovery",
		"none",
		AuthorityDiscoverySchema,
		empty,
	),
	route(
		"GET",
		"/v1/fleet/tenants/{tenant}/discovery",
		"discovery",
		"none",
		DiscoverySchema,
		(input) => {
			const tenant = param(input, "tenant");
			if (!tenant.ok) return tenant;
			try {
				return { ok: true, value: { tenant: parseTenantId(tenant.value) } };
			} catch {
				return invalid("the tenant is not a tenant id");
			}
		},
	),
	{
		method: "GET",
		path: "/v1/fleet/jwks",
		api: "jwks",
		auth: "none",
		async run(context) {
			const outcome = await context.runtime.authority.jwks({}, undefined);
			if (!outcome.ok) return outcome;
			try {
				const parsed: JsonValue = JSON.parse(outcome.value.jwks);
				return { ok: true, value: parsed };
			} catch {
				return {
					ok: false,
					error: { code: "unavailable", message: "the JWKS is not JSON" },
				};
			}
		},
	},
	route(
		"POST",
		"/v1/fleet/signin/start",
		"signInStart",
		"none",
		SignInChallengeSchema,
		(input) => parseBody(SignInStartSchema, input.body),
	),
	route(
		"GET",
		"/v1/fleet/signin/callback",
		"signInCallback",
		"none",
		ApprovalViewSchema,
		(input) =>
			parseBody(
				SignInCallbackSchema,
				JSON.stringify({
					state: input.query.get("state") ?? "",
					code: input.query.get("code") ?? "",
					error: input.query.get("error") ?? "",
				}),
			),
	),
	route(
		"POST",
		"/v1/fleet/signin/device",
		"signInDevice",
		"none",
		SignInChallengeSchema,
		(input) => parseBody(SignInDeviceCodeSchema, input.body),
	),
	route(
		"GET",
		"/v1/fleet/approve/{state}",
		"approval",
		"browser",
		ApprovalViewSchema,
		(input) => byId("state", input, "state"),
	),
	route(
		"POST",
		"/v1/fleet/approve/{state}",
		"approve",
		"browser",
		ApprovalResultSchema,
		(input) => {
			const state = param(input, "state");
			if (!state.ok) return state;
			const body = parseBody(ApprovalDecisionSchema, input.body);
			if (!body.ok) return body;
			if (body.value.state.length > 0 && body.value.state !== state.value)
				return invalid("the body names another sign-in than the path");
			body.value.state = state.value;
			return body;
		},
	),
	route(
		"POST",
		"/v1/fleet/signin/complete",
		"signInComplete",
		"signin-key",
		PersonCredentialSchema,
		(input) => parseBody(SignInCompleteSchema, input.body),
		// D56: the proof is not in the method signature; sign-in checks it against the started key.
		(context, request) =>
			context.runtime.signIn.complete(request, context.dpop),
	),
	route(
		"POST",
		"/v1/fleet/signin/device/poll",
		"signInPoll",
		"signin-key",
		PersonCredentialSchema,
		(input) => parseBody(SignInPollSchema, input.body),
		(context, request) => context.runtime.signIn.poll(request, context.dpop),
	),
	route(
		"POST",
		"/v1/fleet/signin/refresh",
		"signInRefresh",
		["person"],
		PersonCredentialSchema,
		(input) => parseBody(SignInRefreshSchema, input.body),
		// D56: refresh is bound to the DPoP header here, at the transport.
		async (context) =>
			context.caller === undefined
				? {
						ok: false,
						error: {
							code: "unauthenticated",
							message: "refresh needs a person token",
						},
					}
				: context.runtime.signIn.refresh(context.caller, context.dpop),
	),
	route(
		"POST",
		"/v1/fleet/tokens",
		"issueToken",
		["person"],
		TokenCreateResponseSchema,
		(input) => parseBody(TokenCreateRequestSchema, input.body),
	),
	route(
		"GET",
		"/v1/fleet/tokens",
		"listTokens",
		["person"],
		TokenListSchema,
		empty,
	),
	route(
		"DELETE",
		"/v1/fleet/tokens/{id}",
		"revokeToken",
		["person"],
		TokenListSchema,
		(input) => byId("tokenHash", input),
	),
	route(
		"POST",
		"/v1/fleet/members",
		"enroll",
		"identity-key",
		EnrollmentResponseSchema,
		(input) => parseBody(EnrollmentRequestSchema, input.body),
	),
	route(
		"POST",
		"/v1/fleet/members:declare",
		"declare",
		["person", "member", "workload"],
		EnrollmentResponseSchema,
		(input) => parseBody(DeclareRequestSchema, input.body),
	),
	lifecycle("approve-key", "approveKey"),
	lifecycle("accept", "accept"),
	lifecycle("reject", "reject"),
	lifecycle("suspend", "suspend"),
	lifecycle("resume", "resume"),
	lifecycle("unlock", "unlock"),
	lifecycle("revoke", "revoke"),
	route(
		"POST",
		"/v1/fleet/members/{id}/memberships",
		"assign",
		["person"],
		SignedEnvelopeSchema,
		(input) => withBody("memberId", MembershipRequestSchema, input),
	),
	route(
		"POST",
		"/v1/fleet/members/{id}/credentials",
		"credentials",
		["member"],
		CredentialResponseSchema,
		(input) => withBody("memberId", CredentialRequestSchema, input),
	),
	route(
		"POST",
		"/v1/fleet/members/{id}/keys",
		"rotateKeys",
		["member"],
		SignedEnvelopeSchema,
		(input) => withBody("memberId", KeyRotationRequestSchema, input),
	),
	route(
		"POST",
		"/v1/fleet/members/{id}/leave",
		"leave",
		["member"],
		SignedEnvelopeSchema,
		(input) => byId("memberId", input),
	),
	route(
		"GET",
		"/v1/fleet/members",
		"listMembers",
		READ,
		MemberListSchema,
		(input) => {
			const fleet = input.query.get("fleet");
			if (fleet === null || fleet.length === 0) return { ok: true, value: {} };
			try {
				return { ok: true, value: { fleet: parseFleetId(fleet) } };
			} catch {
				return invalid("fleet is not a fleet id");
			}
		},
	),
	route(
		"GET",
		"/v1/fleet/members/{id}",
		"getMember",
		READ,
		SignedEnvelopeSchema,
		(input) => byId("memberId", input),
	),
	route("GET", "/v1/fleet/fleets", "listFleets", READ, FleetListSchema, empty),
	route(
		"GET",
		"/v1/fleet/fleets/{id}",
		"getFleet",
		READ,
		SignedEnvelopeSchema,
		(input) => byId("fleetId", input),
	),
	route(
		"PUT",
		"/v1/fleet/fleets/{id}",
		"defineFleet",
		["person"],
		SignedEnvelopeSchema,
		(input) => {
			const id = param(input, "id");
			if (!id.ok) return id;
			const record = parseBody(FleetRecordSchema, input.body);
			if (!record.ok) return record;
			if (record.value.fleetId.length === 0) record.value.fleetId = id.value;
			return record.value.fleetId === id.value
				? record
				: invalid("the body names another fleet than the path");
		},
	),
	route(
		"GET",
		"/v1/fleet/fleets/{id}/view",
		"fleetView",
		READ,
		SignedEnvelopeSchema,
		(input) => byId("fleetId", input),
	),
	route(
		"GET",
		"/v1/fleet/fleets/{id}/verdict",
		"fleetVerdict",
		[...READ, "workload"],
		FleetVerdictSchema,
		(input) => {
			const id = byId("fleetId", input);
			if (!id.ok) return id;
			const label = input.query.get("label") ?? "";
			if (label.length > 256) return invalid("label is too long");
			return { ok: true, value: { ...id.value, label } };
		},
	),
	route(
		"POST",
		"/v1/fleet/sessions",
		"grantSession",
		["person", "member"],
		SignedEnvelopeSchema,
		(input) => parseBody(SessionRequestSchema, input.body),
	),
	route(
		"POST",
		"/v1/fleet/work",
		"submitWork",
		["person", "account"],
		WorkStatusSchema,
		(input) => parseBody(WorkSubmissionRequestSchema, input.body),
	),
	route(
		"GET",
		"/v1/fleet/work/{id}",
		"workStatus",
		["person", "account"],
		WorkStatusSchema,
		(input) => byId("submissionId", input),
	),
	route(
		"GET",
		"/v1/fleet/work/{id}/logs",
		"workLogs",
		["person", "account"],
		WorkLogsSchema,
		(input) => byId("submissionId", input),
	),
	route(
		"POST",
		"/v1/fleet/reports",
		"report",
		["member"],
		SignedEnvelopeSchema,
		(input) => parseBody(ViolationReportSchema, input.body),
	),
	route(
		"GET",
		"/v1/fleet/audit/checkpoints",
		"auditCheckpoints",
		["person"],
		AuditCheckpointsSchema,
		(input) => {
			const from = integer(input.query.get("from"), "from");
			if (!from.ok) return from;
			return {
				ok: true,
				value: from.value === undefined ? {} : { fromSequence: from.value },
			};
		},
	),
	route(
		"GET",
		"/v1/fleet/audit/entries",
		"auditEntries",
		["person"],
		AuditEntriesSchema,
		(input) => {
			const from = integer(input.query.get("from"), "from");
			const to = integer(input.query.get("to"), "to");
			if (!from.ok) return from;
			if (!to.ok) return to;
			if (from.value === undefined || to.value === undefined)
				return invalid("from and to are required");
			return { ok: true, value: { from: from.value, to: to.value } };
		},
	),
];

/** Finds the route for a method and path; `params` holds the decoded captures. */
export function matchRoute(
	method: string,
	pathname: string,
):
	| Readonly<{ route: Route; params: Record<string, string> }>
	| "method"
	| undefined {
	const segments = pathname.split("/");
	let pathMatched = false;
	for (const candidate of ROUTES) {
		const pattern = candidate.path.split("/");
		if (pattern.length !== segments.length) continue;
		const params: Record<string, string> = {};
		let matched = true;
		for (let index = 0; index < pattern.length; index += 1) {
			const part = pattern[index] ?? "";
			const segment = segments[index] ?? "";
			if (part.startsWith("{") && part.endsWith("}")) {
				let decoded: string;
				try {
					decoded = decodeURIComponent(segment);
				} catch {
					matched = false;
					break;
				}
				if (decoded.length === 0 || decoded.includes("/")) {
					matched = false;
					break;
				}
				params[part.slice(1, -1)] = decoded;
			} else if (part !== segment) {
				matched = false;
				break;
			}
		}
		if (!matched) continue;
		pathMatched = true;
		if (candidate.method === method) return { route: candidate, params };
	}
	return pathMatched ? "method" : undefined;
}
