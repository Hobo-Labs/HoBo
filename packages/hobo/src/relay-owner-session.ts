import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
import {
	RELAY_OWNER_CREDENTIALS_PATH,
	RELAY_OWNER_DEVICE_PATH,
	RELAY_OWNER_TOKEN_PATH,
	RelayOwnerCredentialRequestSchema,
	RelayOwnerCredentialSchema,
	type RelayOwnerDeviceAuthorization,
	RelayOwnerDeviceAuthorizationSchema,
	RelayOwnerLoginErrorSchema,
	type RelayOwnerSession as RelayOwnerSessionMessage,
	RelayOwnerSessionSchema,
	RelayOwnerTokenRequestSchema,
} from "@hobo/ci-gh-actions/owner-login";
import { type HttpsOrigin, parseHttpsOrigin } from "@hobo/hobo-ci";
import { z } from "zod";

import {
	OwnerCredentialUnavailable,
	type OwnerStoreSessions,
} from "./owner-store-session.js";

export type RelayLoginCode =
	| "HOBO_RELAY_LOGIN_UNREACHABLE"
	| "HOBO_RELAY_LOGIN_NOT_CONFIGURED"
	| "HOBO_RELAY_LOGIN_DEVICE_FLOW"
	| "HOBO_RELAY_LOGIN_DENIED"
	| "HOBO_RELAY_LOGIN_EXPIRED"
	| "HOBO_RELAY_LOGIN_NOT_OWNER";

export class RelayLoginError extends Error {
	constructor(
		readonly code: RelayLoginCode,
		message: string,
		readonly remediation: readonly string[],
	) {
		super(message);
		this.name = "RelayLoginError";
	}
}

export type RelayConfirmation = Readonly<{
	verificationUri: string;
	userCode: string;
	expiresInSeconds: number;
}>;

export type RelayLoginDeps = Readonly<{
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}>;

export interface RelayOwnerSession {
	readonly origin: HttpsOrigin;
	readonly expiresAt: number;
	readonly credentials: CredentialResolver;
}

const MAX_RESPONSE_BYTES = 16_384;

const Refusal = z.object({ error: z.string().max(64) }).loose();

export function parseRelayOrigin(text: string): HttpsOrigin {
	return parseHttpsOrigin("--relay", text.trim());
}

async function boundedJson(response: Response): Promise<JsonValue> {
	const reader = response.body?.getReader();
	if (reader === undefined) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return z.json().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch {
		return null;
	}
}

function refusalOf(body: JsonValue): string | undefined {
	try {
		return fromJson(RelayOwnerLoginErrorSchema, body, {
			ignoreUnknownFields: true,
		}).error;
	} catch {
		const loose = Refusal.safeParse(body);
		return loose.success ? loose.data.error : undefined;
	}
}

function unreachable(origin: HttpsOrigin): RelayLoginError {
	return new RelayLoginError(
		"HOBO_RELAY_LOGIN_UNREACHABLE",
		`The HoBo CI relay at ${origin} did not answer its owner sign-in.`,
		[
			"Check the relay origin and that the relay is deployed and ready (GET /readyz).",
		],
	);
}

function refusedLogin(origin: HttpsOrigin, error: string): RelayLoginError {
	switch (error) {
		case "not_configured":
			return new RelayLoginError(
				"HOBO_RELAY_LOGIN_NOT_CONFIGURED",
				`The relay at ${origin} has no configured account with a GitHub App installation to sign in to.`,
				[
					"Finish the relay's setup with hobo ci app create and hobo ci connect, then sign in again.",
				],
			);
		case "device_flow_unavailable":
			return new RelayLoginError(
				"HOBO_RELAY_LOGIN_DEVICE_FLOW",
				"HoBo's GitHub App does not have Device Flow enabled.",
				[
					"Enable Device Flow under Identifying and authorizing users in the App's settings, then sign in again.",
				],
			);
		case "access_denied":
			return new RelayLoginError(
				"HOBO_RELAY_LOGIN_DENIED",
				"The owner declined the sign-in at GitHub.",
				["Run the sign-in again and approve it at GitHub."],
			);
		case "expired_token":
			return new RelayLoginError(
				"HOBO_RELAY_LOGIN_EXPIRED",
				"The sign-in code expired before the owner confirmed it.",
				["Run the sign-in again and confirm the new code at GitHub."],
			);
		case "not_owner":
			return new RelayLoginError(
				"HOBO_RELAY_LOGIN_NOT_OWNER",
				"The GitHub account that confirmed the code does not administer the relay's GitHub App installation.",
				[
					"Confirm the code signed in as the owner, or an administrator of the organization the App is installed on.",
				],
			);
		default:
			return unreachable(origin);
	}
}

async function post(
	deps: RelayLoginDeps,
	url: string,
	body: JsonValue,
	authorization?: string,
): Promise<{ status: number; body: JsonValue } | undefined> {
	try {
		const response = await deps.fetch(url, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				...(authorization !== undefined ? { authorization } : undefined),
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(20_000),
		});
		return { status: response.status, body: await boundedJson(response) };
	} catch {
		return undefined;
	}
}

function relayCredentials(
	origin: HttpsOrigin,
	sessionToken: string,
	expiresAt: number,
	deps: RelayLoginDeps,
): CredentialResolver {
	return {
		async resolve(ref, scope) {
			if (ref.startsWith("env://"))
				throw new OwnerCredentialUnavailable(ref, "environment-ref");
			if (deps.now() >= expiresAt)
				throw new OwnerCredentialUnavailable(ref, "relay-session-expired");
			let request: JsonValue;
			try {
				request = toJson(
					RelayOwnerCredentialRequestSchema,
					create(RelayOwnerCredentialRequestSchema, { ref, scope }),
				);
			} catch {
				throw new OwnerCredentialUnavailable(ref, "unsupported-ref");
			}
			const answer = await post(
				deps,
				`${origin}${RELAY_OWNER_CREDENTIALS_PATH}`,
				request,
				`Bearer ${sessionToken}`,
			);
			if (answer === undefined)
				throw new OwnerCredentialUnavailable(ref, "relay-unreachable");
			if (answer.status === 200) {
				try {
					return {
						token: fromJson(RelayOwnerCredentialSchema, answer.body, {
							ignoreUnknownFields: true,
						}).token,
					};
				} catch {
					throw new OwnerCredentialUnavailable(ref, "relay-unreachable");
				}
			}
			switch (refusalOf(answer.body)) {
				case "session_required":
					throw new OwnerCredentialUnavailable(ref, "relay-session-expired");
				case "not_resolvable":
					throw new OwnerCredentialUnavailable(ref, "relay-not-resolvable");
				case "not_bound":
					throw new OwnerCredentialUnavailable(ref, "github-app-not-installed");
				case "invalid_request":
					throw new OwnerCredentialUnavailable(ref, "unsupported-ref");
				case "github_refused":
					throw new OwnerCredentialUnavailable(ref, "github-app-refused");
				default:
					throw new OwnerCredentialUnavailable(ref, "relay-unreachable");
			}
		},
	};
}

export async function signInToRelay(input: {
	readonly origin: HttpsOrigin;
	readonly deps: RelayLoginDeps;
	readonly present: (confirmation: RelayConfirmation) => Promise<void>;
}): Promise<RelayOwnerSession> {
	const { origin, deps } = input;
	const started = await post(deps, `${origin}${RELAY_OWNER_DEVICE_PATH}`, {});
	if (started === undefined) throw unreachable(origin);
	if (started.status !== 200)
		throw refusedLogin(origin, refusalOf(started.body) ?? "");
	let authorization: RelayOwnerDeviceAuthorization;
	try {
		authorization = fromJson(
			RelayOwnerDeviceAuthorizationSchema,
			started.body,
			{
				ignoreUnknownFields: true,
			},
		);
	} catch {
		throw unreachable(origin);
	}
	if (authorization.verificationUri !== "https://github.com/login/device")
		throw unreachable(origin);
	await input.present({
		verificationUri: authorization.verificationUri,
		userCode: authorization.userCode,
		expiresInSeconds: authorization.expiresIn,
	});
	const deadline = deps.now() + authorization.expiresIn * 1000;
	let interval = Math.max(1, authorization.interval) * 1000;
	const poll = toJson(
		RelayOwnerTokenRequestSchema,
		create(RelayOwnerTokenRequestSchema, {
			deviceCode: authorization.deviceCode,
		}),
	);
	while (deps.now() + interval <= deadline) {
		await deps.sleep(interval);
		const answer = await post(deps, `${origin}${RELAY_OWNER_TOKEN_PATH}`, poll);
		if (answer === undefined) continue;
		if (answer.status === 200) {
			let session: RelayOwnerSessionMessage;
			try {
				session = fromJson(RelayOwnerSessionSchema, answer.body, {
					ignoreUnknownFields: true,
				});
			} catch {
				throw unreachable(origin);
			}
			const expiresAt = deps.now() + session.expiresIn * 1000;
			return Object.freeze({
				origin,
				expiresAt,
				credentials: relayCredentials(
					origin,
					session.sessionToken,
					expiresAt,
					deps,
				),
			});
		}
		const refusal = refusalOf(answer.body);
		if (refusal === "authorization_pending") continue;
		if (refusal === "slow_down") {
			const asked = fromJson(RelayOwnerLoginErrorSchema, answer.body, {
				ignoreUnknownFields: true,
			}).interval;
			interval = Math.max(interval + 5000, (asked ?? 0) * 1000);
			continue;
		}
		throw refusedLogin(origin, refusal ?? "");
	}
	throw refusedLogin(origin, "expired_token");
}

export type RelaySessionState =
	| Readonly<{ status: "none" }>
	| Readonly<{ status: "pending"; confirmation: RelayConfirmation }>
	| Readonly<{ status: "established"; expiresInSeconds: number }>
	| Readonly<{ status: "failed"; error: RelayLoginError }>;

export interface RelayOwnerSessions {
	held(): RelayOwnerSession | undefined;
	state(): RelaySessionState;
	begin(input: {
		readonly origin: HttpsOrigin;
		readonly present: (confirmation: RelayConfirmation) => Promise<void>;
	}): Promise<RelayOwnerSession>;
	close(): void;
}

export function createRelayOwnerSessions(
	deps: RelayLoginDeps,
): RelayOwnerSessions {
	let session: RelayOwnerSession | undefined;
	let pending: RelayConfirmation | undefined;
	let failure: RelayLoginError | undefined;
	let attempt = 0;
	const live = () =>
		session !== undefined && deps.now() < session.expiresAt
			? session
			: undefined;
	return {
		held: live,
		state() {
			const current = live();
			if (current !== undefined)
				return {
					status: "established",
					expiresInSeconds: Math.floor((current.expiresAt - deps.now()) / 1000),
				};
			if (pending !== undefined)
				return { status: "pending", confirmation: pending };
			if (failure !== undefined) return { status: "failed", error: failure };
			return { status: "none" };
		},
		async begin({ origin, present }) {
			const mine = ++attempt;
			session = undefined;
			failure = undefined;
			try {
				const signedIn = await signInToRelay({
					origin,
					deps,
					present: async (confirmation) => {
						if (mine === attempt) pending = confirmation;
						await present(confirmation);
					},
				});
				if (mine === attempt) session = signedIn;
				return signedIn;
			} catch (error) {
				if (mine === attempt && error instanceof RelayLoginError)
					failure = error;
				throw error;
			} finally {
				if (mine === attempt) pending = undefined;
			}
		},
		close() {
			attempt++;
			session = undefined;
			pending = undefined;
			failure = undefined;
		},
	};
}

export function relayCredentialsOnDemand(input: {
	readonly sessions: RelayOwnerSessions;
	readonly origin: HttpsOrigin;
	readonly present: (confirmation: RelayConfirmation) => Promise<void>;
}): CredentialResolver {
	let signingIn: Promise<RelayOwnerSession> | undefined;
	const signedIn = async (ref: string) => {
		const held = input.sessions.held();
		if (held !== undefined) return held;
		signingIn ??= input.sessions
			.begin({ origin: input.origin, present: input.present })
			.finally(() => {
				signingIn = undefined;
			});
		try {
			return await signingIn;
		} catch (error) {
			if (error instanceof RelayLoginError)
				throw new OwnerCredentialUnavailable(ref, "relay-sign-in-failed");
			throw error;
		}
	};
	return {
		async resolve(ref, scope) {
			if (ref.startsWith("env://"))
				throw new OwnerCredentialUnavailable(ref, "environment-ref");
			return (await signedIn(ref)).credentials.resolve(ref, scope);
		},
	};
}

export function relayFlagOf(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--") return undefined;
		if (token === "--relay") return args[index + 1];
		if (token?.startsWith("--relay=")) return token.slice("--relay=".length);
	}
	return undefined;
}

export function withoutRelayFlag(args: readonly string[]): string[] {
	const kept: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		if (token === "--") {
			kept.push(...args.slice(index));
			break;
		}
		if (token === "--relay") {
			index += 1;
			continue;
		}
		if (token.startsWith("--relay=")) continue;
		kept.push(token);
	}
	return kept;
}

export function relayOnlyOwnerSession(input: {
	readonly sessions: RelayOwnerSessions;
	readonly credentials: CredentialResolver;
}): Pick<
	OwnerStoreSessions,
	"credentials" | "status" | "entries" | "agentVault"
> {
	const refuse = async (name: string): Promise<never> => {
		throw new OwnerCredentialUnavailable(`owner://${name}`, "no-session");
	};
	return {
		credentials: () => input.credentials,
		status: () => {
			const state = input.sessions.state();
			return state.status === "established"
				? {
						established: false,
						relaySession: { expiresInSeconds: state.expiresInSeconds },
					}
				: { established: false };
		},
		entries: () => ({ read: refuse, write: refuse }),
		agentVault: () => undefined,
	};
}
