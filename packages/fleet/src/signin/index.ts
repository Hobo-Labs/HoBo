/**
 * Person sign-in (L30, design §6.5 "People sign in"): browser and device-code
 * flows, the person's confirmation, and DPoP-bound person credentials.
 * Re-exported by `@hobo/fleet/membership`; `createEnrollmentAuthority` takes
 * it as a part.
 *
 * Every step is one event on `fleet-signin-<state>`, appended at the head the
 * step expects, so replicas sharing a store share the sign-in and each step
 * (callback, decision, code or poll exchange) is taken exactly once.
 */
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { PrincipalRef } from "@hobo/core";
import {
	type ApprovalDecision,
	type ApprovalResult,
	ApprovalResultSchema,
	type ApprovalView,
	ApprovalViewSchema,
	type PersonCredential,
	PersonCredentialSchema,
	PlatformSchema,
	type SignInCallback,
	type SignInChallenge,
	SignInChallengeSchema,
	type SignInComplete,
	type SignInDeviceCode,
	type SignInPoll,
	type SignInStart,
} from "../_generated/fleet_pb.js";
import type { FleetErrorCode } from "../errors.js";
import { fingerprintWords, verifyDpopProof } from "../keys/index.js";
import type {
	AuthorityDeps,
	Outcome,
	ReplayStore,
	SignInProvider,
	VerifiedToken,
} from "../ports.js";
import {
	checkLoopbackUri,
	deviceState,
	isCodeVerifier,
	isProviderId,
	isThumbprint,
	newUserCode,
	parseUserCode,
	pkceChallenge,
	sameText,
	sha256Text,
} from "./checks.js";
import {
	type AppendStep,
	type Authenticated,
	appendAt,
	appendAtHead,
	authenticatedData,
	PERSON_STREAM_PREFIX,
	readPersonSignIns,
	readSignIn,
	type SignInStep,
	STEP_HEAD,
	type Started,
	signInStream,
	startedData,
} from "./stream.js";

/** A sign-in must reach its last step within this long of starting. */
const SIGN_IN_TTL_MS = 10 * 60_000;
/** Person tokens: 15 minutes, refreshable for 12 hours (§6.6). */
const PERSON_TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_WINDOW_MS = 12 * 3_600_000;
const POLL_INTERVAL_SECONDS = 5;
const START_ATTEMPTS = 8;

// public-contract: the authority routes of §6.15 this module names in redirects and DPoP `htu`.
const ROUTES = {
	callback: "/v1/fleet/signin/callback",
	device: "/v1/fleet/signin/device",
	complete: "/v1/fleet/signin/complete",
	poll: "/v1/fleet/signin/device/poll",
	refresh: "/v1/fleet/signin/refresh",
} as const;

function fail<T>(code: FleetErrorCode, message: string): Outcome<T> {
	return { ok: false, error: { code, message } };
}

function ok<T>(value: T): Outcome<T> {
	return { ok: true, value };
}

function principalText(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function fromStep(step: AppendStep, what: string): Outcome<true> {
	if (step.ok) return ok(true);
	return step.conflict
		? fail("conflict", `${what} was already taken`)
		: fail("unavailable", step.message);
}

export function createSignIn(
	deps: Pick<
		AuthorityDeps,
		| "tenant"
		| "store"
		| "bus"
		| "issuer"
		| "directory"
		| "signIn"
		| "now"
		| "log"
	>,
): Readonly<{
	start(request: SignInStart): Promise<Outcome<SignInChallenge>>;
	device(request: SignInDeviceCode): Promise<Outcome<SignInChallenge>>;
	callback(request: SignInCallback): Promise<Outcome<ApprovalView>>;
	approval(state: string): Promise<Outcome<ApprovalView>>;
	approve(request: ApprovalDecision): Promise<Outcome<ApprovalResult>>;
	complete(
		request: SignInComplete,
		dpop: string,
	): Promise<Outcome<PersonCredential>>;
	/** `sign-in-pending` until the person has confirmed; then the credential, once. */
	poll(request: SignInPoll, dpop: string): Promise<Outcome<PersonCredential>>;
	refresh(
		caller: VerifiedToken,
		dpop: string,
	): Promise<Outcome<PersonCredential>>;
}> {
	const { store, tenant, now, log } = deps;

	/** The authority's base URL is the issuer of the pinned trust record. */
	const issuerUrl = (): Outcome<string> => {
		const issuer = deps.bus.registry.trust().issuer.replace(/\/+$/u, "");
		return issuer.length === 0
			? fail("unavailable", "no trust record names the authority's issuer yet")
			: ok(issuer);
	};

	const providerOf = (id: string): SignInProvider | undefined =>
		deps.signIn.find((provider) => provider.id === id);

	/** DPoP replay scoped to sign-in, so a route that also authenticates the caller does not see its own proof as a replay. */
	const replay: ReplayStore = {
		firstUse: (scope, id, expiresAtMs) =>
			deps.bus.replay.firstUse(`fleet-signin:${scope}`, id, expiresAtMs),
	};

	const proveKey = async (
		dpop: string,
		route: string,
		jkt: string,
	): Promise<Outcome<true>> => {
		const base = issuerUrl();
		if (!base.ok) return base;
		const verified = await verifyDpopProof({
			proof: dpop,
			htm: "POST",
			htu: `${base.value}${route}`,
			nowMs: now(),
			replay,
		});
		if (!verified.ok) return verified;
		return sameText(verified.value.jkt, jkt)
			? ok(true)
			: fail(
					"proof-invalid",
					"the DPoP proof is not made with the sign-in key",
				);
	};

	/** Reads a live sign-in: unknown and expired ones are refused alike. */
	const live = async (state: string): Promise<Outcome<SignInStep>> => {
		if (state.length === 0 || state.length > 128)
			return fail("invalid-request", "state is missing or too long");
		let step: SignInStep | undefined;
		try {
			step = await readSignIn(store, state);
		} catch (error) {
			return fail(
				"unavailable",
				error instanceof Error ? error.message : "the store failed",
			);
		}
		if (step === undefined)
			return fail("unauthenticated", "no sign-in has this state");
		if (now() >= step.started.expiresAtMs)
			return fail("unauthenticated", "the sign-in has expired");
		return ok(step);
	};

	const viewOf = (
		state: string,
		started: Started,
		person: Authenticated,
	): ApprovalView => {
		const view = create(ApprovalViewSchema, {
			state,
			principal: principalText(person.principal),
			hostName: started.hostName,
			deviceName: started.deviceName,
			fingerprintWords: [...fingerprintWords(started.dpopThumbprint)],
			deviceFlow: started.deviceFlow,
			expiresAt: new Date(started.expiresAtMs).toISOString(),
		});
		if (started.platformOs.length > 0 || started.platformArch.length > 0)
			view.platform = create(PlatformSchema, {
				os: started.platformOs,
				arch: started.platformArch,
			});
		return view;
	};

	const begin = async (
		state: string,
		started: Started,
	): Promise<Outcome<string>> => {
		const provider = providerOf(started.provider);
		const base = issuerUrl();
		if (provider === undefined)
			return fail(
				"unavailable",
				`sign-in provider ${started.provider} is gone`,
			);
		if (!base.ok) return base;
		try {
			const { url } = await provider.begin({
				state,
				redirectUri: `${base.value}${ROUTES.callback}`,
				codeChallenge: pkceChallenge(started.providerVerifier),
			});
			return ok(url);
		} catch (error) {
			return fail(
				"unavailable",
				error instanceof Error ? error.message : "the sign-in provider failed",
			);
		}
	};

	/** Completes a confirmed sign-in once: the CAS on `SignInCompleted`, then the token. */
	const issue = async (
		state: string,
		step: SignInStep,
	): Promise<Outcome<PersonCredential>> => {
		if (step.step === "completed")
			return fail("conflict", "this sign-in has already been completed");
		if (step.step !== "decided")
			return fail("conflict", "the person has not confirmed this sign-in");
		const { started, person } = step;
		const completed = fromStep(
			await appendAt(
				store,
				signInStream(state),
				STEP_HEAD.decided,
				tenant,
				{
					type: "fleet.SignInCompleted",
					data: { jkt: started.dpopThumbprint },
				},
				person.principal,
			),
			"this sign-in's exchange",
		);
		if (!completed.ok) return completed;
		log("hobo_fleet_sign_in_completed", {
			principal: principalText(person.principal),
			jkt: started.dpopThumbprint,
		});
		const refreshUntilMs = now() + REFRESH_WINDOW_MS;
		const recorded = await appendAtHead(
			store,
			`${PERSON_STREAM_PREFIX}${sha256Text(principalText(person.principal))}`,
			tenant,
			{
				type: "fleet.PersonSignedIn",
				data: {
					state,
					jkt: started.dpopThumbprint,
					refreshUntilMs,
					tags: [...person.tags],
				},
				idempotencyKey: `signin:${state}`,
			},
			person.principal,
		);
		if (!recorded.ok) return fail("unavailable", recorded.message);
		log("hobo_fleet_person_signed_in", {
			principal: principalText(person.principal),
		});
		return credential(person, started.dpopThumbprint, refreshUntilMs);
	};

	const credential = async (
		person: Authenticated,
		jkt: string,
		refreshUntilMs: number,
	): Promise<Outcome<PersonCredential>> => {
		const ttlMs = Math.min(PERSON_TOKEN_TTL_MS, refreshUntilMs - now());
		try {
			const issued = await deps.issuer.issuePerson({
				principal: person.principal,
				tenant,
				tags: person.tags,
				jkt,
				ttlMs,
			});
			return ok(
				create(PersonCredentialSchema, {
					token: issued.token,
					expiresAt: new Date(issued.expiresAtMs).toISOString(),
					refreshUntil: new Date(refreshUntilMs).toISOString(),
					principal: principalText(person.principal),
					tenant,
					tags: [...person.tags],
				}),
			);
		} catch (error) {
			return fail(
				"unavailable",
				error instanceof Error ? error.message : "the issuer failed",
			);
		}
	};

	return Object.freeze({
		async start(request: SignInStart): Promise<Outcome<SignInChallenge>> {
			if (
				!isProviderId(request.provider) ||
				providerOf(request.provider) === undefined
			)
				return fail(
					"invalid-request",
					"provider is not a configured sign-in provider",
				);
			if (request.tenant.length > 0 && request.tenant !== tenant)
				return fail("invalid-request", "tenant is not this authority's tenant");
			if (!isThumbprint(request.dpopThumbprint))
				return fail(
					"invalid-request",
					"dpop_thumbprint is not an RFC 7638 thumbprint",
				);
			if (!isThumbprint(request.codeChallenge))
				return fail(
					"invalid-request",
					"code_challenge is not a PKCE S256 challenge",
				);
			if (request.deviceFlow && request.redirectUri.length > 0)
				return fail(
					"invalid-request",
					"a device-code sign-in has no redirect_uri",
				);
			if (!request.deviceFlow) {
				const redirect = checkLoopbackUri(request.redirectUri);
				if (!redirect.ok) return fail("invalid-request", redirect.reason);
			}
			const base = issuerUrl();
			if (!base.ok) return base;

			const startedAtMs = now();
			const started: Started = {
				provider: request.provider,
				redirectUri: request.redirectUri,
				codeChallenge: request.codeChallenge,
				dpopThumbprint: request.dpopThumbprint,
				deviceFlow: request.deviceFlow,
				hostName: request.hostName,
				deviceName: request.deviceName,
				platformOs: request.platform?.os ?? "",
				platformArch: request.platform?.arch ?? "",
				providerVerifier: randomBytes(32).toString("base64url"),
				expiresAtMs: startedAtMs + SIGN_IN_TTL_MS,
			};
			for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
				const userCode = request.deviceFlow ? newUserCode() : "";
				const state = request.deviceFlow
					? deviceState(userCode)
					: randomBytes(32).toString("base64url");
				const appended = await appendAt(store, signInStream(state), 0, tenant, {
					type: "fleet.SignInStarted",
					data: startedData(started),
				});
				// A taken state is a user code already handed out: draw another.
				if (!appended.ok && appended.conflict) continue;
				if (!appended.ok) return fail("unavailable", appended.message);
				log("hobo_fleet_sign_in_started", {
					provider: started.provider,
					device_flow: started.deviceFlow,
					jkt: started.dpopThumbprint,
				});
				const challenge = {
					state,
					expiresAt: new Date(started.expiresAtMs).toISOString(),
				};
				if (request.deviceFlow)
					return ok(
						create(SignInChallengeSchema, {
							...challenge,
							userCode,
							verificationUrl: `${base.value}${ROUTES.device}`,
							intervalSeconds: POLL_INTERVAL_SECONDS,
						}),
					);
				const authorize = await begin(state, started);
				if (!authorize.ok) return authorize;
				return ok(
					create(SignInChallengeSchema, {
						...challenge,
						authorizeUrl: authorize.value,
					}),
				);
			}
			return fail("conflict", "no free sign-in state after retries");
		},

		async device(request: SignInDeviceCode): Promise<Outcome<SignInChallenge>> {
			const userCode = parseUserCode(request.userCode);
			if (!userCode.ok) return fail("invalid-request", userCode.reason);
			const state = deviceState(userCode.value);
			const step = await live(state);
			if (!step.ok) return step;
			if (!step.value.started.deviceFlow)
				return fail("unauthenticated", "no device-code sign-in has this code");
			if (step.value.step !== "started")
				return fail("conflict", "this code has already been used to sign in");
			const authorize = await begin(state, step.value.started);
			if (!authorize.ok) return authorize;
			return ok(
				create(SignInChallengeSchema, {
					state,
					authorizeUrl: authorize.value,
					expiresAt: new Date(step.value.started.expiresAtMs).toISOString(),
				}),
			);
		},

		async callback(request: SignInCallback): Promise<Outcome<ApprovalView>> {
			const step = await live(request.state);
			if (!step.ok) return step;
			if (step.value.step !== "started")
				return fail(
					"conflict",
					"this sign-in has already been through the provider",
				);
			if (request.error.length > 0 || request.code.length === 0)
				return fail(
					"unauthenticated",
					request.error.length > 0
						? `the sign-in provider refused: ${request.error}`
						: "the sign-in provider sent no code",
				);
			const { started } = step.value;
			const provider = providerOf(started.provider);
			const base = issuerUrl();
			if (provider === undefined)
				return fail(
					"unavailable",
					`sign-in provider ${started.provider} is gone`,
				);
			if (!base.ok) return base;

			let principal: PrincipalRef;
			let claims: Readonly<Record<string, string>>;
			try {
				const completed = await provider.complete({
					code: request.code,
					state: request.state,
					redirectUri: `${base.value}${ROUTES.callback}`,
					codeVerifier: started.providerVerifier,
				});
				if (!completed.ok) return completed;
				principal = completed.value.principal;
				claims = completed.value.claims;
			} catch (error) {
				return fail(
					"unavailable",
					error instanceof Error
						? error.message
						: "the sign-in provider failed",
				);
			}

			let tags: readonly string[];
			try {
				const entries = await deps.directory.tenantsOf(principal, claims);
				const entry = entries.find((candidate) => candidate.tenant === tenant);
				if (entry === undefined)
					return fail(
						"forbidden",
						`${principalText(principal)} belongs to no fleet tenant here`,
					);
				tags = [...entry.tags];
			} catch (error) {
				return fail(
					"unavailable",
					error instanceof Error
						? error.message
						: "the principal directory failed",
				);
			}

			const person: Authenticated = { principal, tags };
			const appended = fromStep(
				await appendAt(
					store,
					signInStream(request.state),
					STEP_HEAD.started,
					tenant,
					{
						type: "fleet.SignInAuthenticated",
						data: authenticatedData(person),
					},
					principal,
				),
				"this sign-in's provider callback",
			);
			if (!appended.ok) return appended;
			log("hobo_fleet_sign_in_authenticated", {
				principal: principalText(principal),
				provider: started.provider,
			});
			return ok(viewOf(request.state, started, person));
		},

		async approval(state: string): Promise<Outcome<ApprovalView>> {
			const step = await live(state);
			if (!step.ok) return step;
			if (step.value.step !== "authenticated")
				return fail(
					"conflict",
					"this sign-in is not waiting for the person's decision",
				);
			return ok(viewOf(state, step.value.started, step.value.person));
		},

		async approve(request: ApprovalDecision): Promise<Outcome<ApprovalResult>> {
			const step = await live(request.state);
			if (!step.ok) return step;
			if (step.value.step !== "authenticated")
				return fail(
					"conflict",
					"this sign-in is not waiting for the person's decision",
				);
			const { started, person } = step.value;
			const authorityCode =
				request.approve && !started.deviceFlow
					? randomBytes(32).toString("base64url")
					: "";
			const appended = fromStep(
				await appendAt(
					store,
					signInStream(request.state),
					STEP_HEAD.authenticated,
					tenant,
					{
						type: "fleet.SignInApproved",
						data: {
							approved: request.approve,
							codeDigest:
								authorityCode.length > 0 ? sha256Text(authorityCode) : "",
						},
					},
					person.principal,
				),
				"this sign-in's decision",
			);
			if (!appended.ok) return appended;
			log("hobo_fleet_sign_in_approved", {
				principal: principalText(person.principal),
				approved: request.approve,
			});
			if (started.deviceFlow) return ok(create(ApprovalResultSchema, {}));
			const redirect = new URL(started.redirectUri);
			if (request.approve) redirect.searchParams.set("code", authorityCode);
			else redirect.searchParams.set("error", "access_denied");
			redirect.searchParams.set("state", request.state);
			return ok(
				create(ApprovalResultSchema, { redirectUri: redirect.toString() }),
			);
		},

		async complete(
			request: SignInComplete,
			dpop: string,
		): Promise<Outcome<PersonCredential>> {
			const step = await live(request.state);
			if (!step.ok) return step;
			const { started } = step.value;
			if (started.deviceFlow)
				return fail(
					"invalid-request",
					"a device-code sign-in completes by polling",
				);
			if (step.value.step === "decided" && !step.value.decision.approved)
				return fail("forbidden", "the person declined this sign-in");
			if (step.value.step !== "decided" && step.value.step !== "completed")
				return fail("conflict", "the person has not confirmed this sign-in");
			if (!isCodeVerifier(request.codeVerifier))
				return fail("invalid-request", "code_verifier is not a PKCE verifier");
			const proven = await proveKey(
				dpop,
				ROUTES.complete,
				started.dpopThumbprint,
			);
			if (!proven.ok) return proven;
			if (step.value.step === "completed")
				return fail("conflict", "this sign-in has already been completed");
			if (
				!sameText(sha256Text(request.code), step.value.decision.codeDigest) ||
				!sameText(pkceChallenge(request.codeVerifier), started.codeChallenge)
			)
				return fail(
					"unauthenticated",
					"the code or the PKCE verifier does not match",
				);
			return issue(request.state, step.value);
		},

		async poll(
			request: SignInPoll,
			dpop: string,
		): Promise<Outcome<PersonCredential>> {
			const step = await live(request.state);
			if (!step.ok) return step;
			const { started } = step.value;
			if (!started.deviceFlow)
				return fail(
					"invalid-request",
					"a browser sign-in completes at signin/complete",
				);
			const proven = await proveKey(dpop, ROUTES.poll, started.dpopThumbprint);
			if (!proven.ok) return proven;
			if (step.value.step === "started" || step.value.step === "authenticated")
				return fail("sign-in-pending", "the person has not confirmed yet");
			if (step.value.step === "decided" && !step.value.decision.approved)
				return fail("forbidden", "the person declined this sign-in");
			return issue(request.state, step.value);
		},

		async refresh(
			caller: VerifiedToken,
			dpop: string,
		): Promise<Outcome<PersonCredential>> {
			if (caller.kind !== "person")
				return fail("unauthenticated", "only a person token is refreshed here");
			if (caller.tenant !== tenant)
				return fail(
					"unauthenticated",
					"the person token is for another tenant",
				);
			const proven = await proveKey(dpop, ROUTES.refresh, caller.jkt);
			if (!proven.ok) return proven;
			let signIns: Awaited<ReturnType<typeof readPersonSignIns>>;
			try {
				signIns = await readPersonSignIns(
					store,
					`${PERSON_STREAM_PREFIX}${sha256Text(principalText(caller.principal))}`,
				);
			} catch (error) {
				return fail(
					"unavailable",
					error instanceof Error ? error.message : "the store failed",
				);
			}
			const at = now();
			const current = signIns
				.filter(
					(signIn) => signIn.jkt === caller.jkt && signIn.refreshUntilMs > at,
				)
				.sort((a, b) => b.refreshUntilMs - a.refreshUntilMs)[0];
			if (current === undefined)
				return fail(
					"unauthenticated",
					"sign in again: no sign-in of this key is within its 12 hours",
				);
			return credential(
				{ principal: caller.principal, tags: current.tags },
				caller.jkt,
				current.refreshUntilMs,
			);
		},
	});
}
