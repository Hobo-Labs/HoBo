/**
 * Both deployment profiles of §6.16 from one configuration record. The
 * profiles differ only in the event store: standalone journals to SQLite
 * through @hobo/runtime-local (ADR-0135, one writer), high availability to
 * `FLEET_JOURNAL` through @hobo/fleet-nats; every replica of either is a
 * callout responder in one queue group. Everything else is the same:
 *
 * - keys from the secret store (record-signing slot, token ring, NATS
 *   credentials, the callout's xkey and scoped seeds, the browser-session key);
 * - the incarnation from the pinned trust record's `authority_incarnation`,
 *   which a restore raises (carry-forward 1 of L27);
 * - the record signer and the token ring re-read after a rotation (2);
 * - the person directory, account credentials, sign-in providers, pinned OIDC
 *   issuers and overlay minters from the configuration (none when absent).
 *
 * The network clients are parameters, so tests compose with doubles.
 */
import { randomBytes } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	createNetbirdCredentialMinter,
	createTailscaleCredentialMinter,
} from "@hobo/connectivity";
import { createMeteringBus } from "@hobo/core";
import {
	type AuthorityBus,
	type AuthorityDeps,
	type Clock,
	type FleetEventStore,
	type FleetLog,
	type Outcome,
	type OverlayCredentialMinter,
	type SignInProvider,
	type Subscription,
	type TrustRecord,
	TrustRecordSchema,
} from "@hobo/fleet";
import type {
	connectAuthorityBus,
	createJournalEventStore,
	startCalloutResponder,
} from "@hobo/fleet-nats";
import {
	type KmsLike,
	loadSecretStoreKms,
	type SecretsPort,
} from "@hobo/identity";
import { createAccountVerifier, parsePrincipal } from "../identity/accounts.js";
import { createIdentityAssertionVerifier } from "../identity/assertions.js";
import { createPolicyDecisionRecorder } from "../identity/decisions.js";
import {
	combineDirectories,
	createClaimPrincipalDirectory,
	createStaticPrincipalDirectory,
} from "../identity/directory.js";
import { createJwtCredentialIssuer } from "../identity/issuer.js";
import { createTagPolicyEngine } from "../identity/policy.js";
import { createAtprotoSignInProvider } from "../signin/atproto.js";
import { createGithubSignInProvider } from "../signin/github.js";
import { createOidcSignInProvider } from "../signin/oidc.js";
import { type AuthorityRuntime, assembleAuthority } from "./assemble.js";
import type { AuthorityConfig } from "./config.js";
import {
	followingSigner,
	readActiveKey,
	readSecretText,
	requireSecret,
	slotSigner,
} from "./keys.js";

/** How often the token ring and the record-signing slot are re-read. */
const KEY_REFRESH_MS = 60_000;

export type ProfileAdapters = Readonly<{
	secrets: SecretsPort;
	fetch: typeof fetch;
	now: Clock;
	log: FleetLog;
	connectBus: typeof connectAuthorityBus;
	journalStore: typeof createJournalEventStore;
	sqliteStore: (
		dataDir: string,
	) => FleetEventStore & Readonly<{ close?(): void }>;
	startCallout: typeof startCalloutResponder;
}>;

export type ComposedAuthority = Readonly<{
	deps: AuthorityDeps;
	runtime: AuthorityRuntime;
	sessionKey: Uint8Array;
	start(): Promise<void>;
	stop(): Promise<void>;
}>;

function failure<T>(message: string): Outcome<T> {
	return { ok: false, error: { code: "invalid-request", message } };
}

function trustOf(bus: AuthorityBus | undefined): TrustRecord {
	const payload = bus?.registry.trustEnvelope()?.authority?.payload;
	return payload === undefined
		? create(TrustRecordSchema)
		: fromBinary(TrustRecordSchema, payload);
}

async function secretOrEmpty(
	secrets: SecretsPort,
	name: string,
): Promise<string> {
	const text = await readSecretText(secrets, name);
	return text.ok ? (text.value ?? "") : "";
}

function signInProviders(
	config: AuthorityConfig,
	adapters: ProfileAdapters,
): readonly SignInProvider[] {
	const secret = (name: string) => async () => {
		const value = await requireSecret(adapters.secrets, name);
		if (!value.ok) throw new Error(value.error.message);
		return value.value;
	};
	return config.record.signIn.map((entry): SignInProvider => {
		if (entry.id === "github")
			return createGithubSignInProvider({
				clientId: entry.clientId,
				clientSecret: secret(entry.clientSecretSecret),
				webBase: entry.webBase.length > 0 ? entry.webBase : undefined,
				apiBase: entry.apiBase.length > 0 ? entry.apiBase : undefined,
				fetch: adapters.fetch,
			});
		if (entry.id === "atproto")
			return createAtprotoSignInProvider({
				authorizationServer: entry.issuer,
				clientId: entry.clientId,
				fetch: adapters.fetch,
				now: adapters.now,
			});
		return createOidcSignInProvider({
			issuer: entry.issuer,
			clientId: entry.clientId,
			clientSecret:
				entry.clientSecretSecret.length > 0
					? secret(entry.clientSecretSecret)
					: undefined,
			scopes: entry.scopes.length > 0 ? entry.scopes : undefined,
			principalClaim:
				entry.principalClaim.length > 0 ? entry.principalClaim : undefined,
			fetch: adapters.fetch,
			now: adapters.now,
		});
	});
}

function overlayMinters(
	config: AuthorityConfig,
	adapters: ProfileAdapters,
): readonly OverlayCredentialMinter[] {
	return config.record.overlay.map((entry) => {
		const options = {
			apiBase: entry.apiBase,
			organisation: entry.organisation,
			credential: async () => {
				const value = await requireSecret(
					adapters.secrets,
					entry.credentialSecret,
				);
				if (!value.ok) throw new Error(value.error.message);
				return value.value;
			},
			fetch: adapters.fetch,
		};
		return entry.provider === "tailscale"
			? createTailscaleCredentialMinter(options)
			: createNetbirdCredentialMinter(options);
	});
}

export async function composeAuthority(
	config: AuthorityConfig,
	adapters: ProfileAdapters,
): Promise<Outcome<ComposedAuthority>> {
	const { secrets, now, log } = adapters;
	const credentials = await requireSecret(
		secrets,
		config.natsCredentialsSecret,
	);
	if (!credentials.ok) return credentials;
	const record = await slotSigner(
		secrets,
		config.secretPrefix,
		"record-signing",
		now,
		KEY_REFRESH_MS,
	);
	if (!record.ok) return record;

	let ring: KmsLike;
	try {
		ring = await loadSecretStoreKms(secrets, {
			prefix: `${config.secretPrefix}/token-signing`,
		});
	} catch (error) {
		return failure(
			`the token-signing ring cannot be read: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}

	let sessionKey = await secretOrEmpty(secrets, config.sessionKeySecret);
	if (sessionKey.length === 0) {
		// The first replica creates it; replicas that start together converge on the store's latest.
		await secrets.put(
			config.sessionKeySecret,
			randomBytes(32).toString("base64url"),
		);
		sessionKey = await secretOrEmpty(secrets, config.sessionKeySecret);
	}

	let bus: AuthorityBus | undefined;
	bus = await adapters.connectBus({
		servers: config.record.natsUrls,
		credentials: credentials.value,
		trust: () => trustOf(bus),
		log,
	});
	const connected = bus;
	await connected.registry.caughtUp();
	const incarnation = (): number =>
		Math.max(1, Number(trustOf(connected).authorityIncarnation));

	const store: FleetEventStore & Readonly<{ close?(): void }> =
		config.profile === "standalone"
			? adapters.sqliteStore(config.dataDir)
			: await adapters.journalStore({
					servers: config.record.natsUrls,
					credentials: credentials.value,
				});

	const accounts = [];
	for (const entry of config.record.accounts) {
		const principal = parsePrincipal(entry.principal);
		const credential = await secretOrEmpty(secrets, entry.credentialSecret);
		if (principal === undefined)
			return failure(`account ${entry.principal} is not <kind>:<id>`);
		accounts.push({ principal, scopes: entry.scopes, credential });
	}

	const deps: AuthorityDeps = {
		tenant: config.tenant,
		store,
		bus: connected,
		policy: createTagPolicyEngine(),
		decisions: createPolicyDecisionRecorder(),
		issuer: createJwtCredentialIssuer({
			issuerUrl: config.issuer,
			prefix: `${config.secretPrefix}/token-signing`,
			kms: () => ring,
			incarnation,
			now,
		}),
		directory: combineDirectories([
			createStaticPrincipalDirectory(
				config.record.directory.map((entry) => ({
					...entry,
					tenant: config.tenant,
				})),
			),
			createClaimPrincipalDirectory(
				config.record.claimRules.map((rule) => ({
					tenant: config.tenant,
					issuer: rule.issuer.length > 0 ? rule.issuer : undefined,
					claim: rule.claim,
					equals: rule.equals,
					tags: rule.tags,
				})),
			),
		]),
		accounts: createAccountVerifier(config.tenant, accounts),
		signIn: signInProviders(config, adapters),
		assertions: createIdentityAssertionVerifier({
			issuers: config.record.oidcIssuers.map((entry) => ({
				issuer: entry.issuer,
				jwksUri: entry.jwksUri.length > 0 ? entry.jwksUri : undefined,
			})),
			fetch: adapters.fetch,
			now,
		}),
		recordSigner: followingSigner(record.value),
		metering: createMeteringBus(),
		overlayMinters: overlayMinters(config, adapters),
		incarnation: incarnation(),
		now,
		log,
		discovery: {
			issuer: config.issuer,
			natsUrls: config.record.natsUrls,
			natsSentinelCredentials: await secretOrEmpty(
				secrets,
				config.natsSentinelCredentialsSecret,
			),
			relayUrls: config.record.relayUrls,
			minAgentVersion:
				config.record.minAgentVersion.length > 0
					? config.record.minAgentVersion
					: "0.0.0",
		},
	};
	const runtime = assembleAuthority(deps);

	const subscriptions: Subscription[] = [];
	const timers: ReturnType<typeof setInterval>[] = [];
	return {
		ok: true,
		value: {
			deps,
			runtime,
			sessionKey: new Uint8Array(Buffer.from(sessionKey, "base64url")),
			async start() {
				runtime.start();
				const reload = setInterval(() => {
					void (async () => {
						await record.value.refresh().catch(() => {});
						ring = await loadSecretStoreKms(secrets, {
							prefix: `${config.secretPrefix}/token-signing`,
						}).catch(() => ring);
					})();
				}, KEY_REFRESH_MS);
				reload.unref?.();
				timers.push(reload);
				const callout = await startCallout(
					config,
					adapters,
					connected,
					incarnation(),
					runtime,
				);
				if (callout !== undefined) subscriptions.push(callout);
			},
			async stop() {
				for (const timer of timers) clearInterval(timer);
				for (const subscription of subscriptions) await subscription.stop();
				await runtime.stop();
				await connected.close();
				store.close?.();
			},
		},
	};
}

// public-contract: the `status` @hobo/fleet-nats logs (`hobo_fleet_bus_status`, component "callout") for each allowed callout decision.
const CALLOUT_AUTHORISED = "authorised";

/** Every replica answers NATS auth callouts; `nats-callout` availability is recorded per decision it can observe. */
async function startCallout(
	config: AuthorityConfig,
	adapters: ProfileAdapters,
	bus: AuthorityBus,
	incarnation: number,
	runtime: AuthorityRuntime,
): Promise<Subscription | undefined> {
	const xkey = await readSecretText(adapters.secrets, config.calloutXkeySecret);
	const seeds = {
		observer: await readActiveKey(
			adapters.secrets,
			config.secretPrefix,
			"scoped-observer",
		),
		executor: await readActiveKey(
			adapters.secrets,
			config.secretPrefix,
			"scoped-executor",
		),
		dispatcher: await readActiveKey(
			adapters.secrets,
			config.secretPrefix,
			"scoped-dispatcher",
		),
	};
	if (
		!xkey.ok ||
		xkey.value === undefined ||
		!seeds.observer.ok ||
		!seeds.executor.ok ||
		!seeds.dispatcher.ok
	) {
		adapters.log("hobo_fleet_bus_status", {
			component: "callout",
			status: "not-started",
			reason:
				"the callout xkey or a scoped signing key is not in the secret store",
		});
		return undefined;
	}
	const credentials = await requireSecret(
		adapters.secrets,
		config.natsCredentialsSecret,
	);
	if (!credentials.ok) return undefined;
	return adapters.startCallout({
		servers: config.record.natsUrls,
		credentials: credentials.value,
		xkeySeed: xkey.value,
		scopedSeeds: {
			observer: seeds.observer.value.seed,
			executor: seeds.executor.value.seed,
			dispatcher: seeds.dispatcher.value.seed,
		},
		registry: bus.registry,
		replay: bus.replay,
		incarnation,
		now: adapters.now,
		log: (event, fields) => {
			// An allowed decision and a refusal are answers; a request the responder cannot open is a failed one.
			if (event === "hobo_fleet_callout_refused")
				runtime.status.record(
					"nats-callout",
					fields.check !== "request-signature",
				);
			else if (
				event === "hobo_fleet_bus_status" &&
				fields.component === "callout" &&
				fields.status === CALLOUT_AUTHORISED
			)
				runtime.status.record("nats-callout", true);
			adapters.log(event, fields);
		},
	});
}
