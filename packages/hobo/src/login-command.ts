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
import { upsertLoginProfile } from "./hobo-profile.js";
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
