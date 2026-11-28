/**
 * Composed `hobo login` — fixture session by default; real OAuth 2.0
 * device-code grant (RFC 8628) when `HOBO_OIDC_ISSUER` is configured; plus
 * optional default broker association persisted under HOBO_HOME.
 *
 * Fail-closed: once an issuer is explicitly configured, any grant failure
 * (discovery, metadata, denial, expiry, verification) is a typed error —
 * never a silent fixture fallback. Without an issuer, the offline fixture
 * lane is unchanged and first-class.
 *
 * SPIRE-shaped seam: this grant authenticates the HUMAN principal only.
 * Node/workload attestation stays behind @hobo/identity's fixture attestor
 * (`createFixtureHostAttestor`) — a production SPIRE agent replaces that
 * fixture behind the same attestor port (node attestation → workload SVIDs);
 * it is a later adapter, deliberately not part of the login grant.
 */

import {
	type CommandModule,
	type CommandResult,
	createLoginCommand as createCliLoginCommand,
	createFixtureSession,
	type LoginCommandDeps,
	type YardSession,
} from "@hobo/cli";
import type { PrincipalRef } from "@hobo/core";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { resolveBrokerUriFromFlags } from "./broker-target.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

function isPrincipalKind(
	value: string | JsonValue | undefined,
): value is PrincipalRef["kind"] {
	switch (value) {
		case "user":
		case "agent":
		case "service":
		case "system":
			return true;
		default:
			return false;
	}
}

import { SettingParseError } from "@hobo/hobo-ci";
import {
	HoboAlchemyAuthError,
	type HoboAlchemySessionCustody,
	type HoboOwnerSecretResolver,
	resumeHoboAlchemySession,
	revokeHoboAlchemySession,
	runHoboAlchemySetup,
} from "./alchemy-auth-bootstrap.js";
import {
	type HoboAlchemyStorageKind,
	type HoboAlchemyVaultProvider,
	upsertLoginProfile,
} from "./hobo-profile.js";
import {
	DeviceGrantError,
	type DeviceGrantResult,
	type OidcIssuerConfig,
	resolveOidcIssuerConfig,
	runDeviceCodeGrant,
} from "./oidc-device-grant.js";
import {
	parseRelayOrigin,
	RelayLoginError,
	type RelayOwnerSessions,
} from "./relay-owner-session.js";

export type RelayLoginCommandDeps =
	| Readonly<{
			sessions: RelayOwnerSessions;
			openBrowser?: (url: string) => void;
	  }>
	| "owner-channel";

export interface HoboAlchemyAuthCommandDeps {
	readonly resolveOwnerSecret: HoboOwnerSecretResolver;
	readonly sessionCustody?: HoboAlchemySessionCustody;
}

export interface BrokerAwareLoginCommandDeps extends LoginCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Injected fetch for the device-code grant. The composition root wires the
	 * platform fetch; this module never reaches for the global itself, so tests
	 * run the whole grant offline.
	 */
	readonly fetchImpl?: typeof fetch;
	/** Injected sleep seam (poll interval waits). Tests inject a fake; default is a real timer. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Injected clock (epoch ms). */
	readonly now?: () => number;
	readonly relay?: RelayLoginCommandDeps;
	readonly alchemyAuth?: HoboAlchemyAuthCommandDeps;
}

function flagString(
	flags: Readonly<Record<string, JsonValue | undefined>>,
	...names: readonly string[]
): string | undefined {
	for (const name of names) {
		const candidate = flags[name];
		if (isJsonString(candidate) && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

function flagTrue(
	flags: Readonly<Record<string, JsonValue | undefined>>,
	...names: readonly string[]
): boolean {
	for (const name of names) {
		const candidate = flags[name];
		if (candidate === true || candidate === "true") {
			return true;
		}
	}
	return false;
}

function parseVaultProviderFlag(
	value: string | undefined,
): HoboAlchemyVaultProvider | undefined {
	if (value === undefined) return undefined;
	switch (value) {
		case "owner-store":
		case "infisical":
		case "doppler":
			return value;
		default:
			throw new HoboAlchemyAuthError(
				"HOBO_AUTH_INVALID_FLAG",
				`Invalid --vault-provider value "${value}" (expected owner-store, infisical, or doppler).`,
				["Pass --vault-provider owner-store | infisical | doppler."],
			);
	}
}

function parseStorageKindFlag(
	value: string | undefined,
): HoboAlchemyStorageKind | undefined {
	if (value === undefined) return undefined;
	switch (value) {
		case "sqlite-local":
		case "sqlite-shared":
		case "secondary-sqlite":
		case "rivet-actor":
			return value;
		default:
			throw new HoboAlchemyAuthError(
				"HOBO_AUTH_INVALID_FLAG",
				`Invalid --storage value "${value}" (expected sqlite-local, sqlite-shared, secondary-sqlite, or rivet-actor).`,
				[
					"Pass --storage sqlite-local | sqlite-shared | secondary-sqlite | rivet-actor.",
				],
			);
	}
}

async function runAlchemyAuthLoginLane(
	deps: BrokerAwareLoginCommandDeps,
	flags: Readonly<Record<string, JsonValue | undefined>>,
	hoboHome: string,
	mode: "setup" | "resume" | "revoke",
): Promise<CommandResult> {
	if (deps.alchemyAuth === undefined) {
		return {
			ok: false,
			status: "error",
			code: "HOBO_AUTH_OWNER_STORE_REQUIRED",
			message:
				"Alchemy auth onboarding and session reuse require an active owner secret store session (owner://HOBO_AUTH_SECRET).",
			remediation: [
				"Connect the owner's secret store via HoBo MCP choose_secret_store before running hobo login --setup or --resume.",
			],
			data: { command: "login", authMethod: `alchemy-${mode}` },
		};
	}

	const workspaceId = flagString(flags, "workspace", "workspaceId");
	const sessionId = flagString(flags, "session", "sessionId");
	const boxId = flagString(flags, "box", "boxId");
	const profileName = flagString(flags, "alchemyProfile", "alchemy-profile");
	const stage = flagString(flags, "stage");
	const issuerOrigin = flagString(flags, "issuer", "issuerOrigin");
	const basePath = flagString(flags, "basePath", "base-path");
	const signingKeyLocator = flagString(
		flags,
		"signingKeyRef",
		"signing-key-ref",
		"signingSecretRef",
		"signing-secret-ref",
	);
	const authDbPath = flagString(flags, "authDb", "auth-db");
	const secondaryDbPath = flagString(flags, "secondaryDb", "secondary-db");
	const domainDbPath = flagString(flags, "domainDb", "domain-db");
	const ownerPrincipalId = flagString(flags, "principal", "ownerPrincipalId");

	try {
		const vaultProvider = parseVaultProviderFlag(
			flagString(
				flags,
				"vaultProvider",
				"vault-provider",
				"secretProvider",
				"secret-provider",
			),
		);
		const storageKind = parseStorageKindFlag(
			flagString(flags, "storage", "storageKind"),
		);
		if (mode === "setup") {
			const ownerEmail = flagString(flags, "email") ?? "owner@hobo.localhost";
			const ownerName = flagString(flags, "name");
			const setup = await runHoboAlchemySetup({
				hoboHome,
				resolveOwnerSecret: deps.alchemyAuth.resolveOwnerSecret,
				...(deps.alchemyAuth.sessionCustody !== undefined
					? { sessionCustody: deps.alchemyAuth.sessionCustody }
					: undefined),
				ownerEmail,
				...(ownerName !== undefined ? { ownerName } : undefined),
				...(ownerPrincipalId !== undefined ? { ownerPrincipalId } : undefined),
				...(workspaceId !== undefined ? { workspaceId } : undefined),
				...(sessionId !== undefined ? { sessionId } : undefined),
				...(profileName !== undefined ? { profileName } : undefined),
				...(stage !== undefined ? { stage } : undefined),
				...(vaultProvider !== undefined ? { vaultProvider } : undefined),
				...(issuerOrigin !== undefined ? { issuerOrigin } : undefined),
				...(basePath !== undefined ? { basePath } : undefined),
				...(signingKeyLocator !== undefined
					? { signingKeyLocator }
					: undefined),
				...(storageKind !== undefined ? { storageKind } : undefined),
				...(boxId !== undefined ? { boxId } : undefined),
				...(authDbPath !== undefined ? { authDbPath } : undefined),
				...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
				...(domainDbPath !== undefined ? { domainDbPath } : undefined),
				...(deps.now !== undefined ? { now: deps.now } : undefined),
			});
			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `Alchemy auth onboarding complete (${setup.profile.workspaceId}, box=${setup.profile.boxId}); session ready for restarts and cross-box reuse.`,
				data: {
					command: "login",
					authMethod: "alchemy-setup",
					authProvider: setup.authProvider,
					workspaceId: setup.profile.workspaceId,
					workspacePhase: setup.workspacePhase,
					sessionId: setup.profile.sessionId,
					boxId: setup.profile.boxId,
					profilePath: setup.profilePath,
					signingKeyLocator: setup.profile.signingKeyLocator,
					signingKeyFingerprint: setup.profile.signingKeyFingerprint,
					sessionHandleDigest: setup.sessionHandleDigest,
					reusableAcrossBoxes: setup.reusableAcrossBoxes,
				},
			};
		}

		if (mode === "resume") {
			const resumed = await resumeHoboAlchemySession({
				hoboHome,
				resolveOwnerSecret: deps.alchemyAuth.resolveOwnerSecret,
				...(deps.alchemyAuth.sessionCustody !== undefined
					? { sessionCustody: deps.alchemyAuth.sessionCustody }
					: undefined),
				...(boxId !== undefined ? { boxId } : undefined),
				authorizeNewBox: flagTrue(flags, "authorizeBox", "authorize-box"),
				...(workspaceId !== undefined ? { workspaceId } : undefined),
				...(sessionId !== undefined ? { sessionId } : undefined),
				...(ownerPrincipalId !== undefined ? { ownerPrincipalId } : undefined),
				...(profileName !== undefined ? { profileName } : undefined),
				...(stage !== undefined ? { stage } : undefined),
				...(vaultProvider !== undefined ? { vaultProvider } : undefined),
				...(issuerOrigin !== undefined ? { issuerOrigin } : undefined),
				...(basePath !== undefined ? { basePath } : undefined),
				...(signingKeyLocator !== undefined
					? { signingKeyLocator }
					: undefined),
				...(storageKind !== undefined ? { storageKind } : undefined),
				...(authDbPath !== undefined ? { authDbPath } : undefined),
				...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
				...(domainDbPath !== undefined ? { domainDbPath } : undefined),
				...(deps.now !== undefined ? { now: deps.now } : undefined),
			});
			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: resumed.crossBox
					? `Resumed Better Auth session ${resumed.sessionId} on new box ${resumed.boxId}.`
					: `Resumed Better Auth session ${resumed.sessionId} on box ${resumed.boxId}.`,
				data: {
					command: "login",
					authMethod: "alchemy-resume",
					resumed: resumed.resumed,
					crossBox: resumed.crossBox,
					boxId: resumed.boxId,
					sessionId: resumed.sessionId,
					workspaceId: resumed.workspaceId,
					principalId: resumed.principalId,
					resumeCount: resumed.resumeCount,
					observedBoxes: [...resumed.observedBoxes],
					signingKeyFingerprint: resumed.signingKeyFingerprint,
					profilePath: resumed.profilePath,
				},
			};
		}

		const reason = flagString(flags, "reason");
		const revoked = await revokeHoboAlchemySession({
			hoboHome,
			resolveOwnerSecret: deps.alchemyAuth.resolveOwnerSecret,
			...(deps.alchemyAuth.sessionCustody !== undefined
				? { sessionCustody: deps.alchemyAuth.sessionCustody }
				: undefined),
			...(reason !== undefined ? { reason } : undefined),
			...(stage !== undefined ? { stage } : undefined),
			...(sessionId !== undefined ? { sessionId } : undefined),
			...(workspaceId !== undefined ? { workspaceId } : undefined),
			...(ownerPrincipalId !== undefined ? { ownerPrincipalId } : undefined),
			...(issuerOrigin !== undefined ? { issuerOrigin } : undefined),
			...(basePath !== undefined ? { basePath } : undefined),
			...(signingKeyLocator !== undefined ? { signingKeyLocator } : undefined),
			...(authDbPath !== undefined ? { authDbPath } : undefined),
			...(secondaryDbPath !== undefined ? { secondaryDbPath } : undefined),
			...(domainDbPath !== undefined ? { domainDbPath } : undefined),
		});
		return {
			ok: true,
			status: "ok",
			code: "HOBO_OK",
			message: `Revoked Better Auth session ${revoked.sessionId} across all boxes.`,
			data: {
				command: "login",
				authMethod: "alchemy-revoke",
				revoked: revoked.revoked,
				sessionId: revoked.sessionId,
				workspaceId: revoked.workspaceId,
				reason: revoked.reason,
			},
		};
	} catch (error) {
		if (error instanceof HoboAlchemyAuthError) {
			return {
				ok: false,
				status: "error",
				code: error.code,
				message: error.message,
				...(error.remediation.length > 0
					? { remediation: [...error.remediation] }
					: undefined),
				data: { command: "login", authMethod: `alchemy-${mode}` },
			};
		}
		throw error;
	}
}

async function runRelayLogin(
	relay: RelayLoginCommandDeps | undefined,
	text: string,
	emitProgress: (message: string) => void,
): Promise<CommandResult> {
	if (relay === undefined || relay === "owner-channel")
		return {
			ok: false,
			status: "error",
			code: "HOBO_RELAY_LOGIN_USE_MCP_TOOL",
			message:
				"Through HoBo MCP, sign in to the relay with the relay_login tool: it asks the owner for the address and shows the GitHub code privately, never in a tool result.",
			remediation: ["Call HoBo MCP's relay_login."],
			data: { command: "login", authMethod: "relay-device-code" },
		};
	let origin: ReturnType<typeof parseRelayOrigin>;
	try {
		origin = parseRelayOrigin(text);
	} catch (error) {
		if (!(error instanceof SettingParseError)) throw error;
		return {
			ok: false,
			status: "error",
			code: "HOBO_RELAY_LOGIN_ORIGIN",
			message: error.message,
			remediation: [
				"Pass the relay's https origin: hobo login --relay https://relay.example",
			],
			data: { command: "login", authMethod: "relay-device-code" },
		};
	}
	try {
		await relay.sessions.begin({
			origin,
			present: async (confirmation) => {
				emitProgress(
					`Open ${confirmation.verificationUri}, sign in as the owner of HoBo's GitHub App installation, and enter the code ${confirmation.userCode} (it expires in ${Math.max(1, Math.floor(confirmation.expiresInSeconds / 60))} minutes).`,
				);
				relay.openBrowser?.(confirmation.verificationUri);
			},
		});
		const state = relay.sessions.state();
		return {
			ok: true,
			status: "ok",
			code: "HOBO_OK",
			message:
				"Signed in to the HoBo CI relay for this process only: the session is kept in memory and ends when the process exits. Nothing was written to disk.",
			data: {
				command: "login",
				authMethod: "relay-device-code",
				session: "process-memory",
				...(state.status === "established"
					? { expiresInSeconds: state.expiresInSeconds }
					: undefined),
			},
		};
	} catch (error) {
		if (!(error instanceof RelayLoginError)) throw error;
		return {
			ok: false,
			status: "error",
			code: error.code,
			message: error.message,
			remediation: [...error.remediation],
			data: { command: "login", authMethod: "relay-device-code" },
		};
	}
}

export function createBrokerAwareLoginCommand(
	deps: BrokerAwareLoginCommandDeps = {},
): CommandModule {
	const fixtureBase = createCliLoginCommand(deps);
	return {
		implemented: true,
		run: async (input): Promise<CommandResult> => {
			if (isJsonString(input.flags.relay))
				return runRelayLogin(deps.relay, input.flags.relay, input.emitProgress);
			const env = deps.env ?? process.env;
			const hoboHomeFromFlags =
				isJsonString(input.flags.home) && input.flags.home.length > 0
					? input.flags.home
					: defaultHoboHome(env);
			if (flagTrue(input.flags, "setup")) {
				return runAlchemyAuthLoginLane(
					deps,
					input.flags,
					hoboHomeFromFlags,
					"setup",
				);
			}
			if (flagTrue(input.flags, "resume")) {
				return runAlchemyAuthLoginLane(
					deps,
					input.flags,
					hoboHomeFromFlags,
					"resume",
				);
			}
			if (flagTrue(input.flags, "revoke")) {
				return runAlchemyAuthLoginLane(
					deps,
					input.flags,
					hoboHomeFromFlags,
					"revoke",
				);
			}
			const oidc = resolveOidcIssuerConfig(env);

			let result: CommandResult;
			let grant: DeviceGrantResult | null = null;
			if (oidc === null) {
				// Offline default lane: deterministic fixture session, unchanged.
				result = await fixtureBase.run(input);
			} else {
				const authenticated = await runConfiguredGrant(deps, oidc, input);
				if (!authenticated.ok) return authenticated.failure;
				grant = authenticated.grant;
				result = await createCliLoginCommand({
					...deps,
					session: authenticated.session,
				}).run(input);
			}
			if (!result.ok) return result;

			const hoboHome =
				isJsonString(input.flags.home) && input.flags.home.length > 0
					? input.flags.home
					: defaultHoboHome(env);
			const brokerUri = resolveBrokerUriFromFlags({
				broker: input.flags.broker,
				brokerUri: input.flags.brokerUri,
			});

			// SAFETY: assertion required at this I/O or test boundary.
			const data = (result.data ?? {}) as {
				principal?: { kind: string; id: string };
				tenant?: string;
				token?: string;
			};
			const principal = data.principal ?? {
				kind: "user" as const,
				id: "user:local-fixture",
			};
			const tenant = isJsonString(data.tenant) ? data.tenant : "hobo-dev";
			const token = isJsonString(data.token)
				? data.token
				: createFixtureSession().token;

			const profile = upsertLoginProfile({
				hoboHome,
				principal: {
					// SAFETY: assertion required at this I/O or test boundary.
					kind: principal.kind as "user" | "agent" | "service" | "system",
					id: principal.id,
				},
				tenant,
				token,
				...(brokerUri !== null ? { brokerUri } : undefined),
			});

			const message =
				brokerUri !== null
					? `${result.message}; default broker ${brokerUri}`
					: result.message;

			return {
				ok: true,
				status: result.status ?? "ok",
				code: result.code ?? "HOBO_OK",
				message: message ?? "hobo login ok",
				data: {
					...data,
					command: "login",
					profilePath: `${hoboHome}/profile.json`,
					defaultBrokerUri: profile.defaultBrokerUri ?? null,
					// Dual principal note: agent SVIDs are separate from human login.
					principalPlane: "identity",
					...(grant !== null
						? {
								authMethod: "device-code",
								issuer: oidc?.issuer,
								verificationUri: grant.verificationUri,
							}
						: { authMethod: "fixture" }),
				},
			};
		},
	};
}

type ConfiguredGrantOutcome =
	| {
			readonly ok: true;
			readonly grant: DeviceGrantResult;
			readonly session: YardSession;
	  }
	| { readonly ok: false; readonly failure: CommandResult };

async function runConfiguredGrant(
	deps: BrokerAwareLoginCommandDeps,
	oidc: OidcIssuerConfig,
	input: Parameters<CommandModule["run"]>[0],
): Promise<ConfiguredGrantOutcome> {
	const { fetchImpl } = deps;
	if (fetchImpl === undefined) {
		// Fail closed: an issuer was explicitly configured, so a missing network
		// seam is an error — never a silent fixture fallback.
		return {
			ok: false,
			failure: {
				ok: false,
				status: "error",
				code: "HOBO_OIDC_NO_FETCH",
				message: `${oidc.issuer} is configured as the OIDC issuer, but no fetch implementation was injected into the login command.`,
				remediation: [
					"Run login through the composed `hobo` binary (it wires the platform fetch), or inject fetchImpl into createBrokerAwareLoginCommand.",
				],
				data: { command: "login", issuer: oidc.issuer },
			},
		};
	}
	try {
		const grant = await runDeviceCodeGrant({
			config: oidc,
			fetchImpl,
			sleep:
				deps.sleep ??
				((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
			now: deps.now ?? (() => Date.now()),
			emitProgress: input.emitProgress,
		});
		return {
			ok: true,
			grant,
			session: sessionFromVerifiedGrant(grant, deps.now ?? (() => Date.now())),
		};
	} catch (error) {
		if (error instanceof DeviceGrantError) {
			return {
				ok: false,
				failure: {
					ok: false,
					status: "error",
					code: error.code,
					message: error.message,
					remediation: error.remediation,
					data: { command: "login", issuer: oidc.issuer },
				},
			};
		}
		return {
			ok: false,
			failure: {
				ok: false,
				status: "error",
				code: "HOBO_OIDC_GRANT_FAILED",
				message: `Device-code grant failed unexpectedly: ${String(error)}`,
				remediation: [
					"Retry `hobo login`; unset HOBO_OIDC_ISSUER to use the offline fixture session instead.",
				],
				data: { command: "login", issuer: oidc.issuer },
			},
		};
	}
}

/** Map verified grant claims onto the Yard session shape the CLI persists. */
function sessionFromVerifiedGrant(
	grant: DeviceGrantResult,
	now: () => number,
): YardSession {
	const claims = grant.claims;
	const sub = isJsonString(claims.sub) ? claims.sub : "unknown";
	const parent = claims.parentPrincipal;
	const principal: PrincipalRef =
		isJsonObject(parent) &&
		isPrincipalKind(parent.kind) &&
		isJsonString(parent.id)
			? { kind: parent.kind, id: parent.id }
			: { kind: "user", id: sub.includes(":") ? sub : `user:${sub}` };
	const tenant =
		isJsonString(claims.tenant) && claims.tenant.length > 0
			? claims.tenant
			: "hobo-dev";
	return {
		tenant,
		principal,
		token: grant.token,
		issuedAt: new Date(now()).toISOString(),
	};
}
