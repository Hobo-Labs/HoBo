/**
 * A test double of the authority's HTTP surface (rule 6: L09 builds the real
 * service in the same wave). It maps each route of §6.15 to the one
 * `EnrollmentAuthority` method §7.3 names, authenticates exactly as the
 * service must (`authenticate` over method, URL, `Authorization` and `DPoP`),
 * answers protobuf JSON, and turns a `FleetFailure` into its §7.6 status and a
 * `FleetError` body. It also stamps a `Date` header from the authority clock,
 * and lets a test drop or rewrite answers to stage F19 and F7.
 */

import type { Message } from "@bufbuild/protobuf";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { parseTenantId } from "@hobo/core";
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
	FleetErrorSchema,
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
} from "../../src/_generated/fleet_pb.js";
import { FLEET_ERROR_HTTP_STATUS } from "../../src/errors.js";
import { parseFleetId } from "../../src/ids.js";
import type {
	Clock,
	EnrollmentAuthority,
	FleetFailure,
	Outcome,
	VerifiedToken,
} from "../../src/ports.js";

export const AUTHORITY_ORIGIN = "https://authority.fleet.test";

type Answer = Readonly<{ status: number; body: string }>;
type Handler = (
	caller: VerifiedToken | undefined,
	params: readonly string[],
	url: URL,
	text: string,
) => Promise<Answer>;
type Route = Readonly<{
	method: string;
	pattern: RegExp;
	name: string;
	/** "open": no credential needed, a failed one is ignored; "required": a failed one is the answer. */
	auth: "open" | "required";
	handle: Handler;
}>;

/** What a test may do to one exchange after the authority has answered. */
export type Tap = (
	exchange: Readonly<{ route: string; status: number; body: string }>,
) => "deliver" | "drop" | Readonly<{ body: string }>;

function errorAnswer(error: FleetFailure): Answer {
	return {
		status: FLEET_ERROR_HTTP_STATUS[error.code] ?? 400,
		body: toJsonString(
			FleetErrorSchema,
			create(FleetErrorSchema, {
				code: error.code,
				message: error.message,
				detail: { ...error.detail },
			}),
		),
	};
}

function answer<T extends Message>(
	schema: GenMessage<T>,
	outcome: Outcome<T>,
): Answer {
	return outcome.ok
		? { status: 200, body: toJsonString(schema, outcome.value) }
		: errorAnswer(outcome.error);
}

function parse<T extends Message>(schema: GenMessage<T>, text: string): T {
	return fromJsonString(schema, text.length === 0 ? "{}" : text);
}

function numberParam(url: URL, name: string): number | undefined {
	const value = url.searchParams.get(name);
	return value === null ? undefined : Number(value);
}

function routes(authority: EnrollmentAuthority): readonly Route[] {
	const at = (
		method: string,
		pattern: RegExp,
		name: string,
		auth: Route["auth"],
		handle: Handler,
	): Route => ({ method, pattern, name, auth, handle });
	const lifecycle = (
		name:
			| "approveKey"
			| "accept"
			| "reject"
			| "suspend"
			| "resume"
			| "unlock"
			| "revoke",
		suffix: string,
	) =>
		at(
			"POST",
			new RegExp(`^/v1/fleet/members/([^/]+)/${suffix}$`, "u"),
			name,
			"required",
			async (caller, [memberId = ""], _url, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority[name](
						{ memberId, request: parse(LifecycleRequestSchema, text) },
						caller,
					),
				),
		);
	return [
		at(
			"GET",
			/^\/\.well-known\/hobo-fleet$/u,
			"authorityDiscovery",
			"open",
			async (caller) =>
				answer(
					AuthorityDiscoverySchema,
					await authority.authorityDiscovery({}, caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/tenants\/([^/]+)\/discovery$/u,
			"discovery",
			"open",
			async (caller, [tenant = ""]) => {
				const outcome = await authority.discovery(
					{ tenant: parseTenantId(tenant) },
					caller,
				);
				return answer(DiscoverySchema, outcome);
			},
		),
		at("GET", /^\/v1\/fleet\/jwks$/u, "jwks", "open", async (caller) => {
			const outcome = await authority.jwks({}, caller);
			return outcome.ok
				? { status: 200, body: outcome.value.jwks }
				: errorAnswer(outcome.error);
		}),
		at(
			"POST",
			/^\/v1\/fleet\/signin\/start$/u,
			"signInStart",
			"open",
			async (caller, _p, _u, text) =>
				answer(
					SignInChallengeSchema,
					await authority.signInStart(parse(SignInStartSchema, text), caller),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/signin\/complete$/u,
			"signInComplete",
			"open",
			async (caller, _p, _u, text) =>
				answer(
					PersonCredentialSchema,
					await authority.signInComplete(
						parse(SignInCompleteSchema, text),
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/signin\/device\/poll$/u,
			"signInPoll",
			"open",
			async (caller, _p, _u, text) =>
				answer(
					PersonCredentialSchema,
					await authority.signInPoll(parse(SignInPollSchema, text), caller),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/signin\/refresh$/u,
			"signInRefresh",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					PersonCredentialSchema,
					await authority.signInRefresh(
						parse(SignInRefreshSchema, text),
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/tokens$/u,
			"issueToken",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					TokenCreateResponseSchema,
					await authority.issueToken(
						parse(TokenCreateRequestSchema, text),
						caller,
					),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/tokens$/u,
			"listTokens",
			"required",
			async (caller) =>
				answer(TokenListSchema, await authority.listTokens({}, caller)),
		),
		at(
			"DELETE",
			/^\/v1\/fleet\/tokens\/([^/]+)$/u,
			"revokeToken",
			"required",
			async (caller, [tokenHash = ""]) =>
				answer(
					TokenListSchema,
					await authority.revokeToken({ tokenHash }, caller),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/members$/u,
			"enroll",
			"open",
			async (caller, _p, _u, text) =>
				answer(
					EnrollmentResponseSchema,
					await authority.enroll(parse(EnrollmentRequestSchema, text), caller),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/members:declare$/u,
			"declare",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					EnrollmentResponseSchema,
					await authority.declare(parse(DeclareRequestSchema, text), caller),
				),
		),
		lifecycle("approveKey", "approve-key"),
		lifecycle("accept", "accept"),
		lifecycle("reject", "reject"),
		lifecycle("suspend", "suspend"),
		lifecycle("resume", "resume"),
		lifecycle("unlock", "unlock"),
		lifecycle("revoke", "revoke"),
		at(
			"POST",
			/^\/v1\/fleet\/members\/([^/]+)\/memberships$/u,
			"assign",
			"required",
			async (caller, [memberId = ""], _u, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority.assign(
						{ memberId, request: parse(MembershipRequestSchema, text) },
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/members\/([^/]+)\/credentials$/u,
			"credentials",
			"required",
			async (caller, [memberId = ""], _u, text) =>
				answer(
					CredentialResponseSchema,
					await authority.credentials(
						{ memberId, request: parse(CredentialRequestSchema, text) },
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/members\/([^/]+)\/keys$/u,
			"rotateKeys",
			"required",
			async (caller, [memberId = ""], _u, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority.rotateKeys(
						{ memberId, request: parse(KeyRotationRequestSchema, text) },
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/members\/([^/]+)\/leave$/u,
			"leave",
			"required",
			async (caller, [memberId = ""]) =>
				answer(
					SignedEnvelopeSchema,
					await authority.leave({ memberId }, caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/members$/u,
			"listMembers",
			"required",
			async (caller, _p, url) => {
				const fleet = url.searchParams.get("fleet");
				return answer(
					MemberListSchema,
					await authority.listMembers(
						fleet === null ? {} : { fleet: parseFleetId(fleet) },
						caller,
					),
				);
			},
		),
		at(
			"GET",
			/^\/v1\/fleet\/members\/([^/:]+)$/u,
			"getMember",
			"required",
			async (caller, [memberId = ""]) =>
				answer(
					SignedEnvelopeSchema,
					await authority.getMember({ memberId }, caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/fleets$/u,
			"listFleets",
			"required",
			async (caller) =>
				answer(FleetListSchema, await authority.listFleets({}, caller)),
		),
		at(
			"GET",
			/^\/v1\/fleet\/fleets\/([^/]+)$/u,
			"getFleet",
			"required",
			async (caller, [fleetId = ""]) =>
				answer(
					SignedEnvelopeSchema,
					await authority.getFleet({ fleetId }, caller),
				),
		),
		at(
			"PUT",
			/^\/v1\/fleet\/fleets\/([^/]+)$/u,
			"defineFleet",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority.defineFleet(parse(FleetRecordSchema, text), caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/fleets\/([^/]+)\/view$/u,
			"fleetView",
			"required",
			async (caller, [fleetId = ""]) =>
				answer(
					SignedEnvelopeSchema,
					await authority.fleetView({ fleetId }, caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/fleets\/([^/]+)\/verdict$/u,
			"fleetVerdict",
			"required",
			async (caller, [fleetId = ""], url) =>
				answer(
					FleetVerdictSchema,
					await authority.fleetVerdict(
						{ fleetId, label: url.searchParams.get("label") ?? "" },
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/sessions$/u,
			"grantSession",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority.grantSession(
						parse(SessionRequestSchema, text),
						caller,
					),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/work$/u,
			"submitWork",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					WorkStatusSchema,
					await authority.submitWork(
						parse(WorkSubmissionRequestSchema, text),
						caller,
					),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/work\/([^/]+)$/u,
			"workStatus",
			"required",
			async (caller, [submissionId = ""]) =>
				answer(
					WorkStatusSchema,
					await authority.workStatus({ submissionId }, caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/work\/([^/]+)\/logs$/u,
			"workLogs",
			"required",
			async (caller, [submissionId = ""]) =>
				answer(
					WorkLogsSchema,
					await authority.workLogs({ submissionId }, caller),
				),
		),
		at(
			"POST",
			/^\/v1\/fleet\/reports$/u,
			"report",
			"required",
			async (caller, _p, _u, text) =>
				answer(
					SignedEnvelopeSchema,
					await authority.report(parse(ViolationReportSchema, text), caller),
				),
		),
		at(
			"GET",
			/^\/v1\/fleet\/audit\/checkpoints$/u,
			"auditCheckpoints",
			"required",
			async (caller, _p, url) => {
				const fromSequence = numberParam(url, "from");
				return answer(
					AuditCheckpointsSchema,
					await authority.auditCheckpoints(
						fromSequence === undefined ? {} : { fromSequence },
						caller,
					),
				);
			},
		),
		at(
			"GET",
			/^\/v1\/fleet\/audit\/entries$/u,
			"auditEntries",
			"required",
			async (caller, _p, url) =>
				answer(
					AuditEntriesSchema,
					await authority.auditEntries(
						{
							from: numberParam(url, "from") ?? 0,
							to: numberParam(url, "to") ?? 0,
						},
						caller,
					),
				),
		),
	];
}

export type HttpAuthority = Readonly<{
	fetch: typeof fetch;
	/** Route names in call order. */
	calls: readonly string[];
	/** Replace how answers are delivered; the authority has already decided by then. */
	tap(next: Tap | undefined): void;
	/** While false, every request fails before it reaches the authority. */
	reachable(value: boolean): void;
}>;

export function httpAuthority(
	authority: EnrollmentAuthority,
	now: Clock,
	origin: string = AUTHORITY_ORIGIN,
): HttpAuthority {
	const table = routes(authority);
	const calls: string[] = [];
	let tap: Tap | undefined;
	let up = true;

	const handle = async (
		method: string,
		url: URL,
		headers: Headers,
		text: string,
	): Promise<Readonly<{ route: string; answer: Answer }>> => {
		for (const route of table) {
			if (route.method !== method) continue;
			const match = route.pattern.exec(url.pathname);
			if (match === null) continue;
			const authorization = headers.get("authorization") ?? "";
			const dpop = headers.get("dpop") ?? "";
			let caller: VerifiedToken | undefined;
			if (authorization.length > 0 || dpop.length > 0) {
				const verified = await authority.authenticate({
					method,
					url: `${url.origin}${url.pathname}`,
					authorization,
					dpop,
				});
				if (verified.ok) caller = verified.value;
				else if (route.auth === "required")
					return { route: route.name, answer: errorAnswer(verified.error) };
			}
			const params = match.slice(1).map((value) => decodeURIComponent(value));
			try {
				return {
					route: route.name,
					answer: await route.handle(caller, params, url, text),
				};
			} catch (error) {
				return {
					route: route.name,
					answer: errorAnswer({
						code: "invalid-request",
						message: error instanceof Error ? error.message : "bad request",
					}),
				};
			}
		}
		return {
			route: "unknown",
			answer: errorAnswer({
				code: "invalid-request",
				message: "no such route",
			}),
		};
	};

	const fetchDouble: typeof fetch = async (input, init) => {
		if (!up) throw new TypeError("fetch failed: the authority is unreachable");
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== origin)
			throw new TypeError(`unexpected origin ${url.origin}`);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const text =
			init?.body === undefined || init.body === null ? "" : String(init.body);
		const { route, answer: decided } = await handle(method, url, headers, text);
		calls.push(route);
		const verdict =
			tap?.({ route, status: decided.status, body: decided.body }) ?? "deliver";
		if (verdict === "drop")
			throw new TypeError(
				"fetch failed: the connection reset before the answer",
			);
		const delivered = verdict === "deliver" ? decided.body : verdict.body;
		return new Response(delivered, {
			status: decided.status,
			headers: {
				"content-type": "application/json",
				date: new Date(now()).toUTCString(),
			},
		});
	};

	return {
		fetch: fetchDouble,
		calls,
		tap(next) {
			tap = next;
		},
		reachable(value) {
			up = value;
		},
	};
}
