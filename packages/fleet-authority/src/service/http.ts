/**
 * The authority's HTTP service (§6.15) as a fetch-style handler: a WHATWG
 * `Request` in, a `Response` out, so tests run it with no network and
 * `node.ts` serves it. It authenticates the caller by each route's Auth
 * column, calls exactly that route's `FleetApi` method, and writes protobuf
 * JSON, or a `FleetError` with the status of §7.6.
 *
 * Bounds: the URL, the body and the time a call may take. Redirects: only the
 * two of the sign-in path (provider callback to the approval page; the
 * approval to the CLI's loopback address). Credentials are never logged.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fromJsonString, type JsonValue } from "@bufbuild/protobuf";
import {
	ApprovalMode,
	type ApprovalResult,
	ApprovalResultSchema,
	type ApprovalView,
	ApprovalViewSchema,
	type Clock,
	type CredentialIssuer,
	EnrollmentRequestSchema,
	FLEET_ERROR_HTTP_STATUS,
	type FleetErrorCode,
	type FleetEventStore,
	type FleetFailure,
	type FleetLog,
	type Outcome,
	parseFleetId,
	type RegistryView,
	type ReplayStore,
	type VerifiedToken,
} from "@hobo/fleet";
import {
	jwkThumbprint,
	parsePublicJwk,
	verifyDpopProof,
} from "@hobo/fleet/keys";
import type { AuthorityRuntime } from "../compose/assemble.js";
import { signedInByDeviceFlow } from "./device-flow.js";
import { approvalPage, donePage, errorPage } from "./page.js";
import { matchRoute, type Route, type RouteInput } from "./routes.js";

export const DEFAULT_LIMITS = {
	/** Enough for an enrollment with a certificate chain or a work submission. */
	maxBodyBytes: 256 * 1024,
	maxUrlLength: 8 * 1024,
	/** A call that has not answered by then answers `unavailable`. */
	deadlineMs: 30_000,
} as const;

// public-contract: the cookie the sign-in callback sets and the approval routes read (§6.15 "browser session").
export const SESSION_COOKIE = "__Host-hobo-fleet-signin";
const SESSION_CONTEXT = "hobo-fleet/approval-session/v1\u0000";
const SESSION_MAX_AGE_S = 600;

export type AuthorityHttpOptions = Readonly<{
	runtime: AuthorityRuntime;
	/** The authority origin (`https://…`, no trailing slash): DPoP `htu` and redirects are built on it. */
	issuer: string;
	/** HMAC key binding a browser to the sign-in its callback started. Replicas share it. */
	sessionKey: Uint8Array;
	/** The issuer `authenticate` trusts, to read a person token in an enrollment body. */
	credentials: CredentialIssuer;
	store: FleetEventStore;
	registry: () => RegistryView;
	replay: ReplayStore;
	now: Clock;
	log: FleetLog;
	limits?: Partial<Readonly<Record<keyof typeof DEFAULT_LIMITS, number>>>;
}>;

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

function failure(
	code: FleetErrorCode,
	message: string,
	detail?: Readonly<Record<string, string>>,
): FleetFailure {
	return detail === undefined ? { code, message } : { code, message, detail };
}

function statusOf(code: FleetErrorCode): number {
	const table: Readonly<Partial<Record<FleetErrorCode, number | undefined>>> =
		FLEET_ERROR_HTTP_STATUS;
	return table[code] ?? 500;
}

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
} as const;

function jsonResponse(status: number, body: JsonValue): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, "content-type": JSON_TYPE },
	});
}

function errorResponse(
	error: FleetFailure,
	status = statusOf(error.code),
): Response {
	const body: JsonValue =
		error.detail === undefined
			? { code: error.code, message: error.message }
			: {
					code: error.code,
					message: error.message,
					detail: { ...error.detail },
				};
	return jsonResponse(status, body);
}

function htmlResponse(
	status: number,
	html: string,
	extra: Readonly<Record<string, string>> = {},
): Response {
	return new Response(html, {
		status,
		headers: {
			...SECURITY_HEADERS,
			"content-type": HTML_TYPE,
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
			"x-frame-options": "DENY",
			...extra,
		},
	});
}

function redirect(
	location: string,
	extra: Readonly<Record<string, string>> = {},
): Response {
	return new Response(null, {
		status: 303,
		headers: { ...SECURITY_HEADERS, location, ...extra },
	});
}

/** A browser asks for HTML; the CLI and agents ask for JSON. */
function wantsHtml(request: Request): boolean {
	const accept = request.headers.get("accept") ?? "";
	return accept.includes("text/html") && !accept.includes("application/json");
}

function isForm(request: Request): boolean {
	return (request.headers.get("content-type") ?? "").startsWith(
		"application/x-www-form-urlencoded",
	);
}

/** A form's fields as protobuf JSON: `approve` is a boolean, the rest strings. */
function formJson(text: string): string {
	const fields: Record<string, JsonValue> = {};
	for (const [name, value] of new URLSearchParams(text)) {
		fields[
			name.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase())
		] = name === "approve" ? value === "true" : value;
	}
	return JSON.stringify(fields);
}

function cookieOf(request: Request, name: string): string {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return "";
}

function loopback(uri: string): boolean {
	try {
		const url = new URL(uri);
		return (
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
			url.username.length === 0 &&
			url.password.length === 0
		);
	} catch {
		return false;
	}
}

type BodyRead = Readonly<
	{ ok: true; text: string } | { ok: false; response: Response }
>;

async function readBody(request: Request, limit: number): Promise<BodyRead> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	const tooLarge = (): BodyRead => ({
		ok: false,
		response: errorResponse(
			failure("invalid-request", `the body is larger than ${limit} bytes`),
			413,
		),
	});
	if (Number.isFinite(declared) && declared > limit) return tooLarge();
	if (request.body === null) return { ok: true, text: "" };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return tooLarge();
		}
		chunks.push(value);
	}
	return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export function createAuthorityHandler(
	options: AuthorityHttpOptions,
): (request: Request) => Promise<Response> {
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const issuer = options.issuer.replace(/\/+$/u, "");
	const { runtime } = options;

	const sessionFor = (state: string): string =>
		createHmac("sha256", options.sessionKey)
			.update(SESSION_CONTEXT)
			.update(state)
			.digest("base64url");

	const hasSession = (request: Request, state: string): boolean => {
		const presented = Buffer.from(cookieOf(request, SESSION_COOKIE), "utf8");
		const expected = Buffer.from(sessionFor(state), "utf8");
		return (
			presented.length === expected.length &&
			timingSafeEqual(presented, expected)
		);
	};

	/** Scoped so a proof `authenticate` already claimed is not seen as a replay here. */
	const enrollReplay: ReplayStore = {
		firstUse: (scope, id, expiresAtMs) =>
			options.replay.firstUse(`fleet-enroll:${scope}`, id, expiresAtMs),
	};

	const authenticate = async (
		request: Request,
		pathname: string,
	): Promise<Outcome<VerifiedToken>> => {
		const authorization = request.headers.get("authorization") ?? "";
		const dpop = request.headers.get("dpop") ?? "";
		if (authorization.length === 0 && dpop.length === 0)
			return { ok: false, error: failure("unauthenticated", "no credential") };
		try {
			return await runtime.authority.authenticate({
				method: request.method,
				url: `${issuer}${pathname}`,
				authorization,
				dpop,
			});
		} catch {
			return {
				ok: false,
				error: failure("unavailable", "authentication failed to run"),
			};
		}
	};

	/** POST /members: the DPoP proof is made with the request's identity key (§6.5). */
	const admitEnrollment = async (
		request: Request,
		pathname: string,
		body: string,
	): Promise<Outcome<VerifiedToken | undefined>> => {
		let enrollment: ReturnType<
			typeof fromJsonString<typeof EnrollmentRequestSchema>
		>;
		try {
			enrollment = fromJsonString(
				EnrollmentRequestSchema,
				body.length === 0 ? "{}" : body,
			);
		} catch {
			return {
				ok: false,
				error: failure(
					"invalid-request",
					"the body is not an EnrollmentRequest",
				),
			};
		}
		const jwk = parsePublicJwk(enrollment.identityJwk);
		if (!jwk.ok)
			return {
				ok: false,
				error: failure("invalid-request", jwk.error.message),
			};
		const dpop = request.headers.get("dpop") ?? "";
		if (dpop.length === 0)
			return {
				ok: false,
				error: failure(
					"unauthenticated",
					"enrollment needs a DPoP proof with the identity key",
				),
			};
		const proof = await verifyDpopProof({
			proof: dpop,
			htm: request.method,
			htu: `${issuer}${pathname}`,
			nowMs: options.now(),
			replay: enrollReplay,
		});
		if (!proof.ok) return proof;
		const thumbprint = jwkThumbprint(jwk.value);
		if (proof.value.jkt !== thumbprint)
			return {
				ok: false,
				error: failure(
					"proof-invalid",
					"the DPoP proof is not made with the identity key",
				),
			};
		// The device-code flow is refused for fleets that require dual control (§6.5, E17).
		if (enrollment.proof.case === "personToken") {
			const person = options.credentials.verify(
				enrollment.proof.value,
				issuer,
				options.now(),
			);
			if (
				person.ok &&
				person.value.kind === "person" &&
				enrollment.fleet.length > 0
			) {
				const fleet = await options
					.registry()
					.fleet(parseFleetId(enrollment.fleet))
					.catch(() => undefined);
				if (
					fleet?.policy?.approval === ApprovalMode.DUAL &&
					(await signedInByDeviceFlow(
						options.store,
						person.value.principal,
						person.value.jkt,
					))
				)
					return {
						ok: false,
						error: failure(
							"fleet-policy",
							"this fleet requires dual control; sign in with the browser flow, not a device code",
							{ rule: "dual-control-device-code" },
						),
					};
			}
		}
		const authorization = request.headers.get("authorization") ?? "";
		if (authorization.length === 0) return { ok: true, value: undefined };
		return authenticate(request, pathname);
	};

	const admit = async (
		route: Route,
		request: Request,
		pathname: string,
		input: RouteInput,
	): Promise<Outcome<VerifiedToken | undefined>> => {
		const auth = route.auth;
		if (auth === "none") return { ok: true, value: undefined };
		if (auth === "browser")
			return hasSession(request, input.params.state ?? "")
				? { ok: true, value: undefined }
				: {
						ok: false,
						error: failure(
							"unauthenticated",
							"this page needs the browser session the sign-in callback set",
						),
					};
		if (auth === "signin-key")
			return (request.headers.get("dpop") ?? "").length > 0
				? { ok: true, value: undefined }
				: {
						ok: false,
						error: failure(
							"unauthenticated",
							"this step needs a DPoP proof with the sign-in key",
						),
					};
		if (auth === "identity-key")
			return admitEnrollment(request, pathname, input.body);
		const caller = await authenticate(request, pathname);
		if (!caller.ok) return caller;
		return auth.includes(caller.value.kind)
			? caller
			: {
					ok: false,
					error: failure(
						"forbidden",
						`a ${caller.value.kind} credential cannot call ${route.api}`,
					),
				};
	};

	const withDeadline = async <T>(
		work: Promise<Outcome<T>>,
	): Promise<Outcome<T>> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<Outcome<T>>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						ok: false,
						error: failure(
							"unavailable",
							"the authority did not answer in time",
						),
					}),
				limits.deadlineMs,
			);
		});
		try {
			return await Promise.race([work, late]);
		} catch (error) {
			options.log("hobo_fleet_bus_status", {
				component: "http",
				status: "handler-failed",
				reason: error instanceof Error ? error.message : "unknown",
			});
			return {
				ok: false,
				error: failure("unavailable", "the authority failed to answer"),
			};
		} finally {
			clearTimeout(timer);
		}
	};

	/** The browser-facing answers of the sign-in path. */
	const browser = (
		route: Route,
		request: Request,
		input: RouteInput,
		outcome: Outcome<JsonValue>,
	): Response | undefined => {
		const html = wantsHtml(request) || input.form;
		if (!outcome.ok)
			return html
				? htmlResponse(
						statusOf(outcome.error.code),
						errorPage(statusOf(outcome.error.code), outcome.error),
					)
				: undefined;
		if (route.api === "signInCallback") {
			// SAFETY: the callback route answers an ApprovalView (routes.ts).
			const view = fromJsonString(
				ApprovalViewSchema,
				JSON.stringify(outcome.value),
			) as ApprovalView;
			return redirect(
				`${issuer}/v1/fleet/approve/${encodeURIComponent(view.state)}`,
				{
					"set-cookie": `${SESSION_COOKIE}=${sessionFor(view.state)}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`,
				},
			);
		}
		if (route.api === "approval" && html)
			return htmlResponse(
				200,
				approvalPage(
					fromJsonString(ApprovalViewSchema, JSON.stringify(outcome.value)),
				),
			);
		if (route.api === "approve" && html) {
			const result: ApprovalResult = fromJsonString(
				ApprovalResultSchema,
				JSON.stringify(outcome.value),
			);
			if (result.redirectUri.length > 0 && loopback(result.redirectUri))
				return redirect(result.redirectUri);
			return htmlResponse(
				200,
				donePage(!input.body.includes('"approve":false')),
			);
		}
		return undefined;
	};

	return async (request) => {
		if (request.url.length > limits.maxUrlLength)
			return errorResponse(
				failure("invalid-request", "the URL is too long"),
				414,
			);
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return errorResponse(
				failure("invalid-request", "the URL does not parse"),
			);
		}
		const { pathname } = url;
		if (pathname === "/healthz") return jsonResponse(200, { status: "ok" });
		if (pathname === "/readyz")
			return runtime.ready()
				? jsonResponse(200, { status: "ready" })
				: jsonResponse(503, { status: "catching-up" });

		const matched = matchRoute(request.method, pathname);
		if (matched === undefined)
			return errorResponse(
				failure("invalid-request", `no route ${pathname}`),
				404,
			);
		if (matched === "method")
			return errorResponse(
				failure(
					"invalid-request",
					`${request.method} is not allowed on ${pathname}`,
				),
				405,
			);
		const { route, params } = matched;

		const read =
			route.method === "GET"
				? ({ ok: true, text: "" } as const)
				: await readBody(request, limits.maxBodyBytes);
		if (!read.ok) {
			runtime.status.record("enrollment-api", true);
			return read.response;
		}
		const form = isForm(request);
		const input: RouteInput = {
			params,
			query: url.searchParams,
			body: form ? formJson(read.text) : read.text,
			form,
		};

		const outcome = await withDeadline(
			(async (): Promise<Outcome<JsonValue>> => {
				const caller = await admit(route, request, pathname, input);
				if (!caller.ok) return caller;
				return route.run(
					{
						runtime,
						caller: caller.value,
						dpop: request.headers.get("dpop") ?? "",
					},
					input,
				);
			})(),
		);
		const status = outcome.ok ? 200 : statusOf(outcome.error.code);
		runtime.status.record("enrollment-api", status < 500);
		const special =
			route.api === "signInCallback" ||
			route.api === "approval" ||
			route.api === "approve"
				? browser(route, request, input, outcome)
				: undefined;
		if (special !== undefined) return special;
		return outcome.ok
			? jsonResponse(200, outcome.value)
			: errorResponse(outcome.error);
	};
}

/** A fresh session key for a single replica; replicas behind one load balancer are configured with a shared one. */
export function randomSessionKey(): Uint8Array {
	return new Uint8Array(randomBytes(32));
}
