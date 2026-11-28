import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
	createHoboBetterAuthLayer,
	createNodeSqliteBetterAuthDatabaseLayer,
	createSqliteSecondaryStorageLayer,
	fingerprintSigningSecret,
	HoboBetterAuth,
	RuntimeContext,
	runHoboBetterAuthMigrations,
} from "@hobo/iac-alchemy/better-auth";
import {
	createOwnerStoreConfigLayer,
	HOBO_AUTH_PROVIDER_NAME,
	readHoboBetterAuthConfig,
	Stage,
} from "@hobo/iac-alchemy/environments";
import {
	AlchemyProfileName,
	AlchemyStageName,
	AuthBasePath,
	AuthOnboardingApi,
	AuthSessionId,
	authSessionClient,
	BetterAuthIssuerPort,
	type BetterAuthStorageKind,
	BoxId,
	IssuerBootstrapFailed,
	IssuerOrigin,
	IssuerSessionInvalid,
	NonEmptyReason,
	OwnerKeyLocator,
	OwnerVaultPort,
	ownerActor,
	PrincipalId,
	SessionHandleDigest,
	SigningKeyFingerprint,
	TtlSeconds,
	VaultAccessDenied,
	type VaultProviderKind,
	WorkspaceAuthId,
} from "@hobo/identity/domain";
import {
	createAuthOnboardingSqliteLayer,
	createSignedAuthSessionMiddlewareLayer,
	signAuthActorProof,
} from "@hobo/identity/host/sqlite";
import { createNodeSqliteDriver } from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
	type HoboAlchemyAuthProfile,
	type HoboAlchemyStorageKind,
	type HoboAlchemyVaultProvider,
	loadHoboProfile,
	upsertAlchemyAuthProfile,
} from "./hobo-profile.js";

// public-contract: default owner secret locator for Better Auth session signing key.
export const DEFAULT_HOBO_AUTH_SIGNING_KEY_LOCATOR =
	"owner://HOBO_AUTH_SECRET" as const;

// public-contract: default owner secret locator for reusable Better Auth session cookie custody.
export const DEFAULT_HOBO_AUTH_SESSION_COOKIE_LOCATOR =
	"owner://HOBO_AUTH_SESSION_COOKIE" as const;

// public-contract: default owner secret locator for Better Auth bootstrap owner credential.
export const DEFAULT_HOBO_AUTH_OWNER_CREDENTIAL_LOCATOR =
	"owner://HOBO_AUTH_OWNER_PASSCODE" as const;

export type HoboOwnerSecretResolver = (
	secretName: string,
) => Promise<string | undefined> | string | undefined;

export interface HoboAlchemySessionCustody {
	readonly getSessionCookie: () => Promise<string | null> | string | null;
	readonly putSessionCookie?: (cookieHeader: string) => Promise<void> | void;
	readonly clearSessionCookie?: () => Promise<void> | void;
}

export interface HoboAlchemySetupOptions {
	readonly hoboHome: string;
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly sessionCustody?: HoboAlchemySessionCustody;
	readonly workspaceId?: string;
	readonly sessionId?: string;
	readonly ownerEmail: string;
	readonly ownerName?: string;
	readonly ownerPrincipalId?: string;
	readonly profileName?: string;
	readonly stage?: string;
	readonly vaultProvider?: HoboAlchemyVaultProvider;
	readonly issuerOrigin?: string;
	readonly basePath?: string;
	readonly signingKeyLocator?: string;
	readonly storageKind?: HoboAlchemyStorageKind;
	readonly boxId?: string;
	readonly ttlSeconds?: number;
	readonly allowCrossBoxReuse?: boolean;
	readonly authDbPath?: string;
	readonly secondaryDbPath?: string;
	readonly domainDbPath?: string;
	readonly now?: () => number;
}

export interface HoboAlchemySetupResult {
	readonly authProvider: typeof HOBO_AUTH_PROVIDER_NAME;
	readonly profile: HoboAlchemyAuthProfile;
	readonly profilePath: string;
	readonly workspacePhase: string;
	readonly sessionHandleDigest: string;
	readonly sessionCookieHeader: string;
	readonly betterAuthUserId: string;
	readonly reusableAcrossBoxes: boolean;
}

export interface HoboAlchemyResumeOptions {
	readonly hoboHome: string;
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly sessionCustody?: HoboAlchemySessionCustody;
	readonly sessionCookieHeader?: string;
	readonly boxId?: string;
	readonly authorizeNewBox?: boolean;
	readonly workspaceId?: string;
	readonly sessionId?: string;
	readonly ownerPrincipalId?: string;
	readonly profileName?: string;
	readonly stage?: string;
	readonly vaultProvider?: HoboAlchemyVaultProvider;
	readonly issuerOrigin?: string;
	readonly basePath?: string;
	readonly signingKeyLocator?: string;
	readonly storageKind?: HoboAlchemyStorageKind;
	readonly authDbPath?: string;
	readonly secondaryDbPath?: string;
	readonly domainDbPath?: string;
	readonly now?: () => number;
}

export interface HoboAlchemyResumeResult {
	readonly resumed: true;
	readonly crossBox: boolean;
	readonly boxId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly principalId: string;
	readonly resumeCount: number;
	readonly observedBoxes: readonly string[];
	readonly signingKeyFingerprint: string;
	readonly profilePath: string;
}

export interface HoboAlchemyRevokeOptions {
	readonly hoboHome: string;
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly sessionCustody?: HoboAlchemySessionCustody;
	readonly sessionCookieHeader?: string;
	readonly reason?: string;
	readonly sessionId?: string;
	readonly workspaceId?: string;
	readonly ownerPrincipalId?: string;
	readonly stage?: string;
	readonly issuerOrigin?: string;
	readonly basePath?: string;
	readonly signingKeyLocator?: string;
	readonly authDbPath?: string;
	readonly secondaryDbPath?: string;
	readonly domainDbPath?: string;
}

export interface HoboAlchemyRevokeResult {
	readonly revoked: true;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly reason: string;
}

export interface HoboAlchemyAuthDoctorSection {
	readonly configured: boolean;
	readonly authProvider: typeof HOBO_AUTH_PROVIDER_NAME;
	readonly workspaceId?: string;
	readonly profileName?: string;
	readonly stage?: string;
	readonly vaultProvider?: HoboAlchemyVaultProvider;
	readonly issuerOrigin?: string;
	readonly signingKeyLocator?: string;
	readonly storageKind?: HoboAlchemyStorageKind;
	readonly boxId?: string;
	readonly sessionId?: string;
	readonly allowCrossBoxReuse?: boolean;
	readonly sessionExpired?: boolean;
	readonly remediation: readonly string[];
}

export class HoboAlchemyAuthError extends Error {
	readonly code: string;
	readonly remediation: readonly string[];

	constructor(
		code: string,
		message: string,
		remediation: readonly string[] = [],
	) {
		super(message);
		this.name = "HoboAlchemyAuthError";
		this.code = code;
		this.remediation = remediation;
	}
}

function hashSessionCookie(cookieHeader: string): SessionHandleDigest {
	const digest = createHash("sha256").update(cookieHeader).digest("hex");
	return SessionHandleDigest.make(`sha256:${digest}`);
}

function extractCookieHeader(response: Response): string {
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) return "";
	return setCookie
		.split(/,(?=\s*[^;=]+=[^;]+)/u)
		.map((part) => part.split(";")[0]?.trim() ?? "")
		.filter((pair) => pair.length > 0)
		.join("; ");
}

function defaultBoxId(): string {
	const raw = hostname().replace(/[^a-zA-Z0-9._:-]/gu, "-");
	return raw.length > 0 ? `box-${raw}` : "box-local";
}

function ensureParentDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function locatorToSecretName(locator: string): string {
	const match = /^owner:\/\/([A-Z][A-Z0-9_]{1,127})$/u.exec(locator);
	if (!match?.[1]) {
		throw new HoboAlchemyAuthError(
			"HOBO_AUTH_INVALID_LOCATOR",
			`Signing key locator must use owner://<NAME> syntax (received ${locator}).`,
			["Pass --signing-key-ref owner://HOBO_AUTH_SECRET."],
		);
	}
	return match[1];
}

function createBetterAuthConfigLayer(input: {
	readonly stage: string;
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly signingKeyLocator: string;
	readonly issuerOrigin: string;
	readonly basePath: string;
}) {
	const secretName = locatorToSecretName(input.signingKeyLocator);
	return createOwnerStoreConfigLayer({
		keys: {
			HOBO_AUTH_SECRET: input.signingKeyLocator,
		},
		nonSecretValues: {
			HOBO_AUTH_BASE_URL: input.issuerOrigin,
			HOBO_AUTH_BASE_PATH: input.basePath,
			HOBO_AUTH_TRUSTED_ORIGINS: input.issuerOrigin,
		},
		resolveCredential: async () => {
			const value = await input.resolveOwnerSecret(secretName);
			if (value === undefined || value.trim().length === 0) {
				throw new Error(`owner secret ${input.signingKeyLocator} not found`);
			}
			return value;
		},
	}).pipe(Layer.provide(Layer.succeed(Stage, input.stage)));
}

async function resolveSigningSecretFromAlchemy(input: {
	readonly stage: string;
	readonly vaultProvider: HoboAlchemyVaultProvider;
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly signingKeyLocator: string;
	readonly issuerOrigin: string;
	readonly basePath: string;
}) {
	const configLayer = createBetterAuthConfigLayer(input);
	try {
		const resolved = await Effect.runPromise(
			readHoboBetterAuthConfig.pipe(Effect.provide(configLayer)),
		);
		const rawFingerprint = fingerprintSigningSecret(resolved.signingSecret);
		return {
			signingSecret: resolved.signingSecret,
			signingKeyFingerprint: SigningKeyFingerprint.make(rawFingerprint),
			configLayer,
		};
	} catch (error) {
		throw new HoboAlchemyAuthError(
			"HOBO_AUTH_SIGNING_SECRET_UNAVAILABLE",
			`Unable to resolve ${input.signingKeyLocator} through Alchemy Secrets (${input.vaultProvider}): ${error instanceof Error ? error.message : String(error)}`,
			[
				"Connect the owner secret store and populate owner://HOBO_AUTH_SECRET before running setup or resume.",
			],
		);
	}
}

async function resolveOwnerPasscode(
	resolveOwnerSecret: HoboOwnerSecretResolver,
	signingSecret: Redacted.Redacted<string>,
	ownerEmail: string,
): Promise<string> {
	const fromStore = await resolveOwnerSecret("HOBO_AUTH_OWNER_PASSCODE");
	if (fromStore !== undefined && fromStore.length >= 12) {
		return fromStore;
	}
	return createHash("sha256")
		.update(
			`hobo-owner-bootstrap:${ownerEmail}:${Redacted.value(signingSecret)}`,
		)
		.digest("hex");
}

function createRealBetterAuthLayer(input: {
	readonly authDbPath: string;
	readonly secondaryDbPath?: string;
	readonly configLayer: ReturnType<typeof createBetterAuthConfigLayer>;
}) {
	ensureParentDir(input.authDbPath);
	const dbLayer = createNodeSqliteBetterAuthDatabaseLayer(input.authDbPath);
	if (input.secondaryDbPath !== undefined) {
		ensureParentDir(input.secondaryDbPath);
		const secondaryLayer = createSqliteSecondaryStorageLayer(
			input.secondaryDbPath,
		);
		return {
			dbLayer,
			authLayer: createHoboBetterAuthLayer({
				enableEmailAndPassword: true,
				storeSessionInDatabase: true,
			}).pipe(
				Layer.provide(
					Layer.mergeAll(dbLayer, secondaryLayer, input.configLayer),
				),
				Layer.merge(RuntimeContext.phantom),
			),
		};
	}
	return {
		dbLayer,
		authLayer: createHoboBetterAuthLayer({
			enableEmailAndPassword: true,
			storeSessionInDatabase: true,
		}).pipe(
			Layer.provide(Layer.mergeAll(dbLayer, input.configLayer)),
			Layer.merge(RuntimeContext.phantom),
		),
	};
}

function buildLiveDomainPorts(input: {
	readonly signingKeyFingerprint: SigningKeyFingerprint;
	readonly reusableAcrossBoxes: boolean;
	readonly authDbPath: string;
	readonly secondaryDbPath?: string;
	readonly configLayer: ReturnType<typeof createBetterAuthConfigLayer>;
	readonly issuerOrigin: IssuerOrigin;
	readonly basePath: AuthBasePath;
	readonly getCookieHeader: () => Promise<string | null>;
	readonly onSessionRevoked?: () => void;
}) {
	const vaultPort = OwnerVaultPort.toLayer(
		Effect.succeed({
			verifyKeyLocator: ({ vaultProvider, signingKeyLocator }) =>
				Effect.tryPromise({
					try: async () => {
						const verified = await Effect.runPromise(
							readHoboBetterAuthConfig.pipe(Effect.provide(input.configLayer)),
						);
						return {
							signingKeyFingerprint: SigningKeyFingerprint.make(
								fingerprintSigningSecret(verified.signingSecret),
							),
							reusableAcrossBoxes: input.reusableAcrossBoxes,
						};
					},
					catch: (error) =>
						new VaultAccessDenied({
							vaultProvider,
							signingKeyLocator,
							reason: NonEmptyReason.make(
								error instanceof Error ? error.message : String(error),
							),
						}),
				}),
			invalidateCachedAccess: () => Effect.succeed({ invalidated: true }),
		}),
	);

	const issuerPort = BetterAuthIssuerPort.toLayer(
		Effect.succeed({
			bootstrapIssuer: ({ issuerOrigin, signingKeyFingerprint }) =>
				Effect.tryPromise({
					try: async () => {
						const { dbLayer } = createRealBetterAuthLayer({
							authDbPath: input.authDbPath,
							...(input.secondaryDbPath !== undefined
								? { secondaryDbPath: input.secondaryDbPath }
								: undefined),
							configLayer: input.configLayer,
						});
						await Effect.runPromise(
							runHoboBetterAuthMigrations({
								enableEmailAndPassword: true,
								storeSessionInDatabase: true,
							}).pipe(
								Effect.scoped,
								Effect.provide(
									Layer.mergeAll(
										dbLayer,
										input.configLayer,
										RuntimeContext.phantom,
									),
								),
							),
						);
						return {
							migrationsApplied: true,
							signingKeyFingerprint,
						};
					},
					catch: (error) =>
						new IssuerBootstrapFailed({
							issuerOrigin,
							reason: NonEmptyReason.make(
								error instanceof Error ? error.message : String(error),
							),
						}),
				}),
			verifySessionHandle: ({ handleDigest }) =>
				Effect.tryPromise({
					try: async () => {
						const cookieHeader = await input.getCookieHeader();
						if (!cookieHeader) {
							throw new Error("missing Better Auth session cookie");
						}
						const { authLayer } = createRealBetterAuthLayer({
							authDbPath: input.authDbPath,
							...(input.secondaryDbPath !== undefined
								? { secondaryDbPath: input.secondaryDbPath }
								: undefined),
							configLayer: input.configLayer,
						});
						const resolved = await Effect.runPromise(
							Effect.gen(function* () {
								const service = yield* HoboBetterAuth;
								const nativeAuth = yield* service.instance.auth;
								return yield* Effect.tryPromise({
									try: () =>
										nativeAuth.api.getSession({
											headers: new Headers({ cookie: cookieHeader }),
										}),
									catch: (cause) =>
										new IssuerSessionInvalid({
											handleDigest,
											reason: NonEmptyReason.make(
												cause instanceof Error ? cause.message : String(cause),
											),
										}),
								});
							}).pipe(Effect.scoped, Effect.provide(authLayer)),
						);
						if (!resolved) {
							throw new Error("Better Auth session is no longer active");
						}
						return {
							active: true,
							principalId: PrincipalId.make(`user:${resolved.user.email}`),
						};
					},
					catch: (error) =>
						new IssuerSessionInvalid({
							handleDigest,
							reason: NonEmptyReason.make(
								error instanceof Error ? error.message : String(error),
							),
						}),
				}),
			revokeSessionHandle: ({ handleDigest }) =>
				Effect.tryPromise({
					try: async () => {
						const cookieHeader = await input.getCookieHeader();
						if (!cookieHeader) {
							throw new Error(
								"cannot revoke Better Auth session without session cookie custody",
							);
						}
						const { authLayer } = createRealBetterAuthLayer({
							authDbPath: input.authDbPath,
							...(input.secondaryDbPath !== undefined
								? { secondaryDbPath: input.secondaryDbPath }
								: undefined),
							configLayer: input.configLayer,
						});
						await Effect.runPromise(
							Effect.gen(function* () {
								const service = yield* HoboBetterAuth;
								const nativeAuth = yield* service.instance.auth;
								const response = yield* Effect.tryPromise({
									try: () =>
										nativeAuth.handler(
											new Request(
												`${input.issuerOrigin}${input.basePath}/sign-out`,
												{
													method: "POST",
													headers: {
														cookie: cookieHeader,
														origin: input.issuerOrigin,
													},
												},
											),
										),
									catch: (cause) =>
										new IssuerSessionInvalid({
											handleDigest,
											reason: NonEmptyReason.make(
												cause instanceof Error ? cause.message : String(cause),
											),
										}),
								});
								if (!response.ok) {
									return yield* new IssuerSessionInvalid({
										handleDigest,
										reason: NonEmptyReason.make(
											`Better Auth sign-out returned HTTP ${response.status}`,
										),
									});
								}
							}).pipe(Effect.scoped, Effect.provide(authLayer)),
						);
						input.onSessionRevoked?.();
						return { revoked: true };
					},
					catch: (error) =>
						error instanceof IssuerSessionInvalid
							? error
							: new IssuerSessionInvalid({
									handleDigest,
									reason: NonEmptyReason.make(
										error instanceof Error ? error.message : String(error),
									),
								}),
				}),
		}),
	);

	return { vaultPort, issuerPort };
}

export async function runHoboAlchemySetup(
	options: HoboAlchemySetupOptions,
): Promise<HoboAlchemySetupResult> {
	const vaultProvider: VaultProviderKind =
		options.vaultProvider ?? "owner-store";
	const profileName = AlchemyProfileName.make(options.profileName ?? "default");
	const stage = AlchemyStageName.make(options.stage ?? "dev");
	const issuerOrigin = IssuerOrigin.make(
		options.issuerOrigin ?? "http://auth.hobo.localhost",
	);
	const basePath = AuthBasePath.make(options.basePath ?? "/api/auth");
	const signingKeyLocator = OwnerKeyLocator.make(
		options.signingKeyLocator ?? DEFAULT_HOBO_AUTH_SIGNING_KEY_LOCATOR,
	);
	const storageKind: BetterAuthStorageKind =
		options.storageKind ?? "sqlite-shared";
	const boxId = BoxId.make(options.boxId ?? defaultBoxId());
	const workspaceId = WorkspaceAuthId.make(
		options.workspaceId ?? `ws-${profileName}-${stage}`,
	);
	const sessionId = AuthSessionId.make(
		options.sessionId ?? `sess-${workspaceId}`,
	);
	const ownerPrincipalId = PrincipalId.make(
		options.ownerPrincipalId ?? `user:${options.ownerEmail}`,
	);
	const ttlSeconds = TtlSeconds.make(options.ttlSeconds ?? 86_400);
	const allowCrossBoxReuse = options.allowCrossBoxReuse ?? true;
	const authDbPath =
		options.authDbPath ?? join(options.hoboHome, "better-auth.sqlite");
	const secondaryDbPath =
		options.secondaryDbPath ??
		(storageKind === "secondary-sqlite"
			? join(options.hoboHome, "better-auth-secondary.sqlite")
			: undefined);
	const domainDbPath =
		options.domainDbPath ?? join(options.hoboHome, "auth-onboarding.sqlite");

	ensureParentDir(authDbPath);
	ensureParentDir(domainDbPath);

	const { signingSecret, signingKeyFingerprint, configLayer } =
		await resolveSigningSecretFromAlchemy({
			stage,
			vaultProvider,
			resolveOwnerSecret: options.resolveOwnerSecret,
			signingKeyLocator,
			issuerOrigin,
			basePath,
		});

	let activeCookieHeader = "";
	const { vaultPort, issuerPort } = buildLiveDomainPorts({
		signingKeyFingerprint,
		reusableAcrossBoxes: allowCrossBoxReuse,
		authDbPath,
		...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
		configLayer,
		issuerOrigin,
		basePath,
		getCookieHeader: async () =>
			activeCookieHeader ||
			(await options.sessionCustody?.getSessionCookie()) ||
			null,
	});

	const ownerProof = signAuthActorProof(
		ownerActor(ownerPrincipalId),
		signingSecret,
	);
	const middlewareLayer = createSignedAuthSessionMiddlewareLayer(signingSecret);

	const domainDriver = createNodeSqliteDriver({ path: domainDbPath });
	let workspacePhase = "ProvisioningIssuer";
	try {
		const world = createAuthOnboardingSqliteLayer(
			domainDriver,
			vaultPort,
			issuerPort,
			middlewareLayer,
		);
		workspacePhase = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const current = yield* client.WorkspaceOnboardingView.get(workspaceId);
				if (
					current !== null &&
					current._tag === "Ready" &&
					current.issuerOrigin === issuerOrigin &&
					current.basePath === basePath &&
					current.storageKind === storageKind &&
					current.signingKeyLocator === signingKeyLocator &&
					current.signingKeyFingerprint === signingKeyFingerprint
				) {
					if (!current.authorizedBoxes.includes(boxId)) {
						const authReceipt = yield* client.AuthorizeBox(workspaceId, {
							boxId,
						});
						yield* client.WorkspaceOnboardingView.get(workspaceId, {
							atLeast: authReceipt,
						});
					}
					return current._tag;
				}
				if (current === null || current._tag === "Uninitialized") {
					yield* client.BeginOnboarding(workspaceId, {
						profileName,
						stage,
						vaultProvider,
						signingKeyLocator,
						initialBoxId: boxId,
					});
				}
				const configured = yield* client.ConfigureBetterAuthIssuer(
					workspaceId,
					{
						issuerOrigin,
						basePath,
						storageKind,
					},
				);
				yield* client.WorkspaceOnboardingView.get(workspaceId, {
					atLeast: configured,
				});
				const deadline = Date.now() + 5_000;
				for (;;) {
					const view = yield* client.WorkspaceOnboardingView.get(workspaceId);
					if (view?._tag === "Ready") {
						return view._tag;
					}
					if (view?._tag === "Suspended") {
						return yield* Effect.fail(
							new HoboAlchemyAuthError(
								"HOBO_AUTH_BOOTSTRAP_SUSPENDED",
								`Auth workspace bootstrap failed closed: ${view.reason}`,
								[
									"Verify owner://HOBO_AUTH_SECRET and rerun hobo login --setup.",
								],
							),
						);
					}
					if (Date.now() >= deadline) {
						return yield* Effect.fail(
							new HoboAlchemyAuthError(
								"HOBO_AUTH_BOOTSTRAP_TIMEOUT",
								"Auth workspace bootstrap did not reach Ready state before timeout.",
							),
						);
					}
					yield* Effect.sleep("25 millis");
				}
			}).pipe(Effect.scoped, Effect.provide(world)),
		);
	} finally {
		domainDriver.close();
	}

	const { authLayer } = createRealBetterAuthLayer({
		authDbPath,
		...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
		configLayer,
	});
	const ownerPasscode = await resolveOwnerPasscode(
		options.resolveOwnerSecret,
		signingSecret,
		options.ownerEmail,
	);

	const betterAuthSession = await Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* HoboBetterAuth;
			const nativeAuth = yield* service.instance.auth;
			const signUpResponse = yield* Effect.tryPromise({
				try: () =>
					nativeAuth.handler(
						new Request(`${issuerOrigin}${basePath}/sign-up/email`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								origin: issuerOrigin,
							},
							body: JSON.stringify({
								email: options.ownerEmail,
								password: ownerPasscode,
								name: options.ownerName ?? "HoBo Owner",
							}),
						}),
					),
				catch: (cause) =>
					new HoboAlchemyAuthError(
						"HOBO_AUTH_BETTER_AUTH_UNAVAILABLE",
						`Better Auth sign-up unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
					),
			});
			let cookieHeader = extractCookieHeader(signUpResponse);
			if (!signUpResponse.ok || cookieHeader.length === 0) {
				const signInResponse = yield* Effect.tryPromise({
					try: () =>
						nativeAuth.handler(
							new Request(`${issuerOrigin}${basePath}/sign-in/email`, {
								method: "POST",
								headers: {
									"content-type": "application/json",
									origin: issuerOrigin,
								},
								body: JSON.stringify({
									email: options.ownerEmail,
									password: ownerPasscode,
								}),
							}),
						),
					catch: (cause) =>
						new HoboAlchemyAuthError(
							"HOBO_AUTH_BETTER_AUTH_UNAVAILABLE",
							`Better Auth sign-in unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
						),
				});
				if (!signInResponse.ok) {
					return yield* Effect.fail(
						new HoboAlchemyAuthError(
							"HOBO_AUTH_BETTER_AUTH_SIGNIN_FAILED",
							`Better Auth sign-in failed with HTTP ${signInResponse.status}.`,
						),
					);
				}
				cookieHeader = extractCookieHeader(signInResponse);
			}
			const verified = yield* Effect.tryPromise({
				try: () =>
					nativeAuth.api.getSession({
						headers: new Headers({ cookie: cookieHeader }),
					}),
				catch: (cause) =>
					new HoboAlchemyAuthError(
						"HOBO_AUTH_BETTER_AUTH_UNAVAILABLE",
						`Better Auth session verification unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
					),
			});
			if (!verified) {
				return yield* Effect.fail(
					new HoboAlchemyAuthError(
						"HOBO_AUTH_SESSION_ESTABLISH_FAILED",
						"Better Auth did not return an active session after onboarding sign-in.",
					),
				);
			}
			return { cookieHeader, userId: verified.user.id };
		}).pipe(Effect.scoped, Effect.provide(authLayer)),
	);

	activeCookieHeader = betterAuthSession.cookieHeader;
	const handleDigest = hashSessionCookie(activeCookieHeader);
	await options.sessionCustody?.putSessionCookie?.(activeCookieHeader);

	const sessionDriver = createNodeSqliteDriver({ path: domainDbPath });
	let effectiveSessionId = sessionId;
	let expiresAtMs = (options.now?.() ?? Date.now()) + ttlSeconds * 1000;
	try {
		const world = createAuthOnboardingSqliteLayer(
			sessionDriver,
			vaultPort,
			issuerPort,
			middlewareLayer,
		);
		const established = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const existingSession = yield* client.ActiveSessionView.get(sessionId);
				if (
					existingSession !== null &&
					existingSession._tag === "Active" &&
					existingSession.signingKeyFingerprint === signingKeyFingerprint &&
					existingSession.observedBoxes.includes(boxId) &&
					(options.now?.() ?? Date.now()) < existingSession.expiresAtMs
				) {
					const refreshReceipt = yield* client.RefreshAuthSession(sessionId, {
						boxId,
						nextHandleDigest: handleDigest,
						signingKeyFingerprint,
						ttlSeconds,
					});
					const refreshedView = yield* client.ActiveSessionView.get(sessionId, {
						atLeast: refreshReceipt,
					});
					return { sessionId, view: refreshedView };
				}
				const targetSessionId =
					existingSession !== null && existingSession._tag !== "Empty"
						? AuthSessionId.make(`${sessionId}-${randomUUID().slice(0, 8)}`)
						: sessionId;
				const receipt = yield* client.EstablishAuthSession(targetSessionId, {
					workspaceId,
					issuerOrigin,
					handleDigest,
					signingKeyFingerprint,
					boxId,
					ttlSeconds,
					allowCrossBoxReuse,
				});
				const view = yield* client.ActiveSessionView.get(targetSessionId, {
					atLeast: receipt,
				});
				return { sessionId: targetSessionId, view };
			}).pipe(Effect.scoped, Effect.provide(world)),
		);
		effectiveSessionId = established.sessionId;
		if (established.view?._tag === "Active") {
			expiresAtMs = established.view.expiresAtMs;
		}
	} finally {
		sessionDriver.close();
	}

	const alchemyProfile: HoboAlchemyAuthProfile = {
		workspaceId,
		ownerPrincipalId,
		profileName,
		stage,
		vaultProvider,
		issuerOrigin,
		basePath,
		signingKeyLocator,
		storageKind,
		boxId,
		sessionId: effectiveSessionId,
		handleDigest,
		signingKeyFingerprint,
		expiresAtMs,
		allowCrossBoxReuse,
		authDbPath,
		domainDbPath,
	};
	upsertAlchemyAuthProfile(options.hoboHome, alchemyProfile);

	return {
		authProvider: HOBO_AUTH_PROVIDER_NAME,
		profile: alchemyProfile,
		profilePath: join(options.hoboHome, "profile.json"),
		workspacePhase,
		sessionHandleDigest: handleDigest,
		sessionCookieHeader: activeCookieHeader,
		betterAuthUserId: betterAuthSession.userId,
		reusableAcrossBoxes: allowCrossBoxReuse,
	};
}

export async function resumeHoboAlchemySession(
	options: HoboAlchemyResumeOptions,
): Promise<HoboAlchemyResumeResult> {
	const existingProfile = loadHoboProfile(options.hoboHome)?.alchemyAuth;
	const workspaceId = WorkspaceAuthId.make(
		options.workspaceId ??
			existingProfile?.workspaceId ??
			(() => {
				throw new HoboAlchemyAuthError(
					"HOBO_AUTH_PROFILE_MISSING",
					"No Alchemy auth onboarding profile found in HOBO_HOME and no --workspace was supplied.",
					["Run `hobo login --setup` first or pass --workspace and --session."],
				);
			})(),
	);
	const sessionId = AuthSessionId.make(
		options.sessionId ?? existingProfile?.sessionId ?? `sess-${workspaceId}`,
	);
	const ownerPrincipalId = PrincipalId.make(
		options.ownerPrincipalId ??
			existingProfile?.ownerPrincipalId ??
			(() => {
				throw new HoboAlchemyAuthError(
					"HOBO_AUTH_PRINCIPAL_MISSING",
					"Owner principal is required to resume an Alchemy auth session.",
				);
			})(),
	);
	const profileName = AlchemyProfileName.make(
		options.profileName ?? existingProfile?.profileName ?? "default",
	);
	const stage = AlchemyStageName.make(
		options.stage ?? existingProfile?.stage ?? "dev",
	);
	const vaultProvider: VaultProviderKind =
		options.vaultProvider ?? existingProfile?.vaultProvider ?? "owner-store";
	const issuerOrigin = IssuerOrigin.make(
		options.issuerOrigin ??
			existingProfile?.issuerOrigin ??
			"http://auth.hobo.localhost",
	);
	const basePath = AuthBasePath.make(
		options.basePath ?? existingProfile?.basePath ?? "/api/auth",
	);
	const signingKeyLocator = OwnerKeyLocator.make(
		options.signingKeyLocator ??
			existingProfile?.signingKeyLocator ??
			DEFAULT_HOBO_AUTH_SIGNING_KEY_LOCATOR,
	);
	const storageKind: BetterAuthStorageKind =
		options.storageKind ?? existingProfile?.storageKind ?? "sqlite-shared";
	const boxId = BoxId.make(
		options.boxId ?? existingProfile?.boxId ?? defaultBoxId(),
	);
	const authDbPath =
		options.authDbPath ??
		existingProfile?.authDbPath ??
		join(options.hoboHome, "better-auth.sqlite");
	const secondaryDbPath =
		options.secondaryDbPath ??
		(storageKind === "secondary-sqlite"
			? join(dirname(authDbPath), "better-auth-secondary.sqlite")
			: undefined);
	const domainDbPath =
		options.domainDbPath ??
		existingProfile?.domainDbPath ??
		join(options.hoboHome, "auth-onboarding.sqlite");

	const { signingSecret, signingKeyFingerprint, configLayer } =
		await resolveSigningSecretFromAlchemy({
			stage,
			vaultProvider,
			resolveOwnerSecret: options.resolveOwnerSecret,
			signingKeyLocator,
			issuerOrigin,
			basePath,
		});

	const cookieHeader =
		options.sessionCookieHeader ??
		(await options.sessionCustody?.getSessionCookie()) ??
		null;
	if (!cookieHeader) {
		throw new HoboAlchemyAuthError(
			"HOBO_AUTH_SESSION_COOKIE_MISSING",
			"No reusable Better Auth session cookie available from owner custody.",
			[
				"Unlock the owner secret store holding the session cookie or rerun `hobo login --setup`.",
			],
		);
	}

	const { authLayer } = createRealBetterAuthLayer({
		authDbPath,
		...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
		configLayer,
	});
	const liveSession = await Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* HoboBetterAuth;
			const nativeAuth = yield* service.instance.auth;
			return yield* Effect.tryPromise({
				try: () =>
					nativeAuth.api.getSession({
						headers: new Headers({ cookie: cookieHeader }),
					}),
				catch: (cause) =>
					new HoboAlchemyAuthError(
						"HOBO_AUTH_BETTER_AUTH_UNAVAILABLE",
						`Better Auth session lookup unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
					),
			});
		}).pipe(Effect.scoped, Effect.provide(authLayer)),
	);
	if (!liveSession) {
		throw new HoboAlchemyAuthError(
			"HOBO_AUTH_BETTER_AUTH_SESSION_INVALID",
			"Better Auth rejected the stored session cookie (expired, signed out, or signing secret rotated).",
			["Run `hobo login --setup` to establish a fresh session."],
		);
	}

	const { vaultPort, issuerPort } = buildLiveDomainPorts({
		signingKeyFingerprint,
		reusableAcrossBoxes: existingProfile?.allowCrossBoxReuse ?? true,
		authDbPath,
		...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
		configLayer,
		issuerOrigin,
		basePath,
		getCookieHeader: async () => cookieHeader,
	});
	const ownerProof = signAuthActorProof(
		ownerActor(ownerPrincipalId),
		signingSecret,
	);
	const middlewareLayer = createSignedAuthSessionMiddlewareLayer(signingSecret);

	const domainDriver = createNodeSqliteDriver({ path: domainDbPath });
	try {
		const world = createAuthOnboardingSqliteLayer(
			domainDriver,
			vaultPort,
			issuerPort,
			middlewareLayer,
		);
		const resumed = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const wsView = yield* client.WorkspaceOnboardingView.get(workspaceId);
				if (wsView === null || wsView._tag !== "Ready") {
					return yield* Effect.fail(
						new HoboAlchemyAuthError(
							"HOBO_AUTH_WORKSPACE_NOT_READY",
							`Auth workspace ${workspaceId} is not ready (phase=${wsView?._tag ?? "Uninitialized"}).`,
						),
					);
				}
				const currentSession = yield* client.ActiveSessionView.get(sessionId);
				if (currentSession === null || currentSession._tag !== "Active") {
					return yield* Effect.fail(
						new HoboAlchemyAuthError(
							"HOBO_AUTH_SESSION_INACTIVE",
							`Auth session ${sessionId} is not active.`,
						),
					);
				}
				const presentedDigest = hashSessionCookie(cookieHeader);
				if (
					currentSession.handleDigest !== presentedDigest ||
					currentSession.principalId !== ownerPrincipalId
				) {
					return yield* Effect.fail(
						new HoboAlchemyAuthError(
							"HOBO_AUTH_SESSION_HANDLE_MISMATCH",
							"Presented Better Auth session cookie does not match the recorded owner session.",
							[
								"Provide the owner session cookie for this workspace or rerun `hobo login --setup`.",
							],
						),
					);
				}
				let boxAuthorized = wsView.authorizedBoxes.includes(boxId);
				if (!boxAuthorized && options.authorizeNewBox === true) {
					const authReceipt = yield* client.AuthorizeBox(workspaceId, {
						boxId,
					});
					const refreshedWs = yield* client.WorkspaceOnboardingView.get(
						workspaceId,
						{ atLeast: authReceipt },
					);
					boxAuthorized =
						refreshedWs?._tag === "Ready" &&
						refreshedWs.authorizedBoxes.includes(boxId);
				}
				const resumeReceipt = yield* client
					.ResumeAuthSession(sessionId, {
						boxId,
						signingKeyFingerprint,
						boxAuthorizedByWorkspace: boxAuthorized,
					})
					.pipe(
						Effect.mapError((rejection) => {
							const tag =
								"_tag" in rejection ? String(rejection._tag) : "ResumeFailed";
							return new HoboAlchemyAuthError(
								`HOBO_AUTH_RESUME_${tag.toUpperCase()}`,
								`Session resume rejected (${tag}).`,
								[
									"Authorize the new box with --authorize-box or rerun `hobo login --setup`.",
								],
							);
						}),
					);
				const sessionView = yield* client.ActiveSessionView.get(sessionId, {
					atLeast: resumeReceipt,
				});
				if (sessionView === null || sessionView._tag !== "Active") {
					return yield* Effect.fail(
						new HoboAlchemyAuthError(
							"HOBO_AUTH_SESSION_INACTIVE",
							"Auth session is not active after resume.",
						),
					);
				}
				return {
					sessionView,
					crossBox: boxId !== sessionView.originBoxId,
				};
			}).pipe(Effect.scoped, Effect.provide(world)),
		);

		upsertAlchemyAuthProfile(options.hoboHome, {
			workspaceId,
			ownerPrincipalId,
			profileName,
			stage,
			vaultProvider,
			issuerOrigin,
			basePath,
			signingKeyLocator,
			storageKind,
			boxId,
			sessionId,
			handleDigest: resumed.sessionView.handleDigest,
			signingKeyFingerprint,
			expiresAtMs: resumed.sessionView.expiresAtMs,
			allowCrossBoxReuse: resumed.sessionView.allowCrossBoxReuse,
			authDbPath,
			domainDbPath,
		});

		return {
			resumed: true,
			crossBox: resumed.crossBox,
			boxId,
			sessionId,
			workspaceId,
			principalId: resumed.sessionView.principalId,
			resumeCount: resumed.sessionView.resumeCount,
			observedBoxes: resumed.sessionView.observedBoxes,
			signingKeyFingerprint,
			profilePath: join(options.hoboHome, "profile.json"),
		};
	} finally {
		domainDriver.close();
	}
}

export async function revokeHoboAlchemySession(
	options: HoboAlchemyRevokeOptions,
): Promise<HoboAlchemyRevokeResult> {
	const existingProfile = loadHoboProfile(options.hoboHome)?.alchemyAuth;
	const workspaceId = WorkspaceAuthId.make(
		options.workspaceId ??
			existingProfile?.workspaceId ??
			(() => {
				throw new HoboAlchemyAuthError(
					"HOBO_AUTH_PROFILE_MISSING",
					"No Alchemy auth onboarding profile found to revoke.",
				);
			})(),
	);
	const sessionId = AuthSessionId.make(
		options.sessionId ?? existingProfile?.sessionId ?? `sess-${workspaceId}`,
	);
	const ownerPrincipalId = PrincipalId.make(
		options.ownerPrincipalId ??
			existingProfile?.ownerPrincipalId ??
			(() => {
				throw new HoboAlchemyAuthError(
					"HOBO_AUTH_PRINCIPAL_MISSING",
					"Owner principal is required to revoke an Alchemy auth session.",
				);
			})(),
	);
	const stage = AlchemyStageName.make(
		options.stage ?? existingProfile?.stage ?? "dev",
	);
	const issuerOrigin = IssuerOrigin.make(
		options.issuerOrigin ??
			existingProfile?.issuerOrigin ??
			"http://auth.hobo.localhost",
	);
	const basePath = AuthBasePath.make(
		options.basePath ?? existingProfile?.basePath ?? "/api/auth",
	);
	const signingKeyLocator = OwnerKeyLocator.make(
		options.signingKeyLocator ??
			existingProfile?.signingKeyLocator ??
			DEFAULT_HOBO_AUTH_SIGNING_KEY_LOCATOR,
	);
	const authDbPath =
		options.authDbPath ??
		existingProfile?.authDbPath ??
		join(options.hoboHome, "better-auth.sqlite");
	const secondaryDbPath =
		options.secondaryDbPath ??
		(existingProfile?.storageKind === "secondary-sqlite"
			? join(dirname(authDbPath), "better-auth-secondary.sqlite")
			: undefined);
	const domainDbPath =
		options.domainDbPath ??
		existingProfile?.domainDbPath ??
		join(options.hoboHome, "auth-onboarding.sqlite");
	const reason = NonEmptyReason.make(options.reason ?? "owner-sign-out");

	const { signingSecret, signingKeyFingerprint, configLayer } =
		await resolveSigningSecretFromAlchemy({
			stage,
			vaultProvider: existingProfile?.vaultProvider ?? "owner-store",
			resolveOwnerSecret: options.resolveOwnerSecret,
			signingKeyLocator,
			issuerOrigin,
			basePath,
		});

	const cookieHeader =
		options.sessionCookieHeader ??
		(await options.sessionCustody?.getSessionCookie()) ??
		null;
	let policyRevokeDone = false;
	const { vaultPort, issuerPort } = buildLiveDomainPorts({
		signingKeyFingerprint,
		reusableAcrossBoxes: existingProfile?.allowCrossBoxReuse ?? true,
		authDbPath,
		...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
		configLayer,
		issuerOrigin,
		basePath,
		getCookieHeader: async () => cookieHeader,
		onSessionRevoked: () => {
			policyRevokeDone = true;
		},
	});
	const ownerProof = signAuthActorProof(
		ownerActor(ownerPrincipalId),
		signingSecret,
	);
	const middlewareLayer = createSignedAuthSessionMiddlewareLayer(signingSecret);

	const domainDriver = createNodeSqliteDriver({ path: domainDbPath });
	try {
		const world = createAuthOnboardingSqliteLayer(
			domainDriver,
			vaultPort,
			issuerPort,
			middlewareLayer,
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* AuthOnboardingApi.clientInProcess.pipe(
					Effect.provide(authSessionClient(ownerProof)),
				);
				const receipt = yield* client.RevokeAuthSession(sessionId, { reason });
				yield* client.ActiveSessionView.get(sessionId, { atLeast: receipt });
				if (cookieHeader !== null) {
					const deadline = Date.now() + 2_000;
					while (!policyRevokeDone && Date.now() < deadline) {
						yield* Effect.sleep("20 millis");
					}
				}
			}).pipe(Effect.scoped, Effect.provide(world)),
		);
	} finally {
		domainDriver.close();
	}

	await options.sessionCustody?.clearSessionCookie?.();

	return {
		revoked: true,
		sessionId,
		workspaceId,
		reason,
	};
}

export function buildAlchemyAuthDoctorSection(
	hoboHome: string,
	nowMs: number = Date.now(),
): HoboAlchemyAuthDoctorSection {
	const profile = loadHoboProfile(hoboHome)?.alchemyAuth;
	if (!profile) {
		return {
			configured: false,
			authProvider: HOBO_AUTH_PROVIDER_NAME,
			remediation: [
				"Run `hobo login --setup` to configure Alchemy auth provider, owner secret store signing key (owner://HOBO_AUTH_SECRET), and reusable Better Auth sessions.",
			],
		};
	}
	const sessionExpired = nowMs >= profile.expiresAtMs;
	const remediation: string[] = [];
	if (sessionExpired) {
		remediation.push(
			"Reusable Better Auth session has expired — run `hobo login --setup` to refresh.",
		);
	}
	return {
		configured: true,
		authProvider: HOBO_AUTH_PROVIDER_NAME,
		workspaceId: profile.workspaceId,
		profileName: profile.profileName,
		stage: profile.stage,
		vaultProvider: profile.vaultProvider,
		issuerOrigin: profile.issuerOrigin,
		signingKeyLocator: profile.signingKeyLocator,
		storageKind: profile.storageKind,
		boxId: profile.boxId,
		sessionId: profile.sessionId,
		allowCrossBoxReuse: profile.allowCrossBoxReuse,
		sessionExpired,
		remediation,
	};
}
