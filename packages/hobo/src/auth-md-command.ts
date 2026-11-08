import { createHash, randomBytes } from "node:crypto";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type AgentPrincipalEvent,
	type AgentRegistration,
	agentRegisteredEvent,
	assertManagementAccess,
	type ClaimedAgentPrincipal,
	type ClaimInitiation,
	claimInitiatedEvent,
	createSensitive,
	discloseSensitive,
	exchangeAgentAccessToken,
	type HttpPort,
	initiateHumanClaim,
	instantFrom,
	materialHandle,
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	parseScopes,
	parseSessionBinding,
	pollHumanClaim,
	principalClaimedEvent,
	type RevokedAgentPrincipalRecord,
	type RotationPort,
	redactText,
	requestJson,
	revokeAgentPrincipal,
	rotateAgentCredentials,
	type SessionBindingInput,
	type StoredCliAuthMdClaimInitiationRecord,
	type StoredCliAuthMdStateRecord,
	scopesSubsetOf,
	sessionBindingsMatch,
} from "@hobo/auth-md";
import type { CommandModule } from "@hobo/cli";
import type { EventStore } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { discoverAuthMdForLifecycle } from "./auth-md-discovery.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import type { PresentedCredential } from "./credential-presenter.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";
import {
	acquireLocalStateLockQueued,
	withLocalStateLockQueued,
} from "./local-state-lock.js";

// domain-view: parsed owner-only persistence view derived from auth_md.proto; public views exclude custody material.
type StoredAuthMdState = Readonly<
	Omit<
		StoredCliAuthMdStateRecord,
		| "$typeName"
		| "schemaVersion"
		| "binding"
		| "preClaimScopes"
		| "initiation"
		| "principal"
		| "revoked"
		| "deployments"
		| "ownedDeployments"
	>
> & {
	readonly schemaVersion: "hobo.cli-authmd/v1";
	readonly binding: SessionBindingInput;
	readonly preClaimScopes: readonly string[];
	readonly deployments?: readonly string[];
	readonly ownedDeployments?: readonly string[];
	readonly revoked?: Readonly<Omit<RevokedAgentPrincipalRecord, "$typeName">>;
	readonly principal?: ClaimedAgentPrincipal;
	readonly initiation?: Omit<ClaimInitiation, "pollToken"> &
		Pick<StoredCliAuthMdClaimInitiationRecord, "pollMaterial">;
};
export interface AuthMdIdentityCommandDeps {
	readonly fallback: CommandModule;
	readonly fetchImpl?: typeof fetch;
	readonly store?: EventStore;
	readonly env?: NodeJS.ProcessEnv;
}
function asJsonObject<T>(value: T): JsonObject {
	const cloned = cloneAsJson(value);
	if (!isJsonObject(cloned))
		throw new Error("Expected an object at the CLI result boundary");
	return cloned;
}
function object(value: import("./json.js").JsonValue | undefined): JsonObject {
	if (!isJsonObject(value)) throw new Error("Expected an auth.md object");
	return value;
}
function textValue(value: import("./json.js").JsonValue | undefined): string {
	if (!isJsonString(value) || value.length === 0)
		throw new Error("Expected a nonempty auth.md string");
	return value;
}
function strings(value: import("./json.js").JsonValue): string[] {
	if (!Array.isArray(value)) throw new Error("Expected auth.md identifiers");
	return value.map(textValue);
}
function parseBinding(value: import("./json.js").JsonValue | undefined) {
	const raw = object(value);
	return parseSessionBinding({
		sessionId: textValue(raw.sessionId),
		tenantId: textValue(raw.tenantId),
		projectId: textValue(raw.projectId),
		audience: textValue(raw.audience),
		service: textValue(raw.service),
	});
}
function parsePrincipal(raw: JsonObject): ClaimedAgentPrincipal {
	if (raw.phase !== "human-bound")
		throw new Error("Invalid agent principal phase");
	return {
		phase: "human-bound",
		registrationRef: parseRegistrationRef(raw.registrationRef),
		binding: parseBinding(raw.binding),
		humanSubject: textValue(raw.humanSubject),
		preClaimScopes: parseScopes(raw.preClaimScopes),
		postClaimScopes: parseScopes(raw.postClaimScopes),
		claimedAt: parseInstant(raw.claimedAt),
		rotateAfterInfrastructureClaim:
			raw.rotateAfterInfrastructureClaim !== false,
		rotationSatisfied: raw.rotationSatisfied === true,
	};
}
function parseInitiation(
	raw: JsonObject,
): NonNullable<StoredAuthMdState["initiation"]> {
	if (!Number.isFinite(raw.intervalSeconds) || Number(raw.intervalSeconds) < 0)
		throw new Error("Invalid polling interval");
	return {
		registrationRef: parseRegistrationRef(raw.registrationRef),
		claimUrl: parseHttpsUrl(raw.claimUrl),
		pollEndpoint: parseHttpsUrl(raw.pollEndpoint),
		expiresAt: parseInstant(raw.expiresAt),
		requestedPostClaimScopes: parseScopes(raw.requestedPostClaimScopes),
		intervalSeconds: Number(raw.intervalSeconds),
		pollMaterial: textValue(raw.pollMaterial),
	};
}
function key(resource: string, ref: string): string {
	return createHash("sha256")
		.update(JSON.stringify([parseHttpsUrl(resource), ref]))
		.digest("hex");
}
function directory(home: string): string {
	return join(home, "auth-md", "registrations");
}
async function prepareAuthMdLock(home: string): Promise<string> {
	const root = join(home, "auth-md");
	const registrations = directory(home);
	await mkdir(root, { recursive: true, mode: 0o700 });
	await mkdir(registrations, { recursive: true, mode: 0o700 });
	await chmod(registrations, 0o700);
	return join(root, "operations-lock.sqlite");
}
async function acquireAuthMdLock(home: string): Promise<() => void> {
	return acquireLocalStateLockQueued(await prepareAuthMdLock(home));
}
async function withAuthMdLock<T>(home: string, operation: () => Promise<T>) {
	return withLocalStateLockQueued(await prepareAuthMdLock(home), operation);
}
function statePath(home: string, resource: string, ref: string): string {
	return join(directory(home), `${key(resource, ref)}.json`);
}
function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`${label} is required`);
	return value;
}
async function save(
	home: string,
	state: StoredAuthMdState,
	createOnly = false,
): Promise<void> {
	const path = statePath(home, state.resource, state.registrationRef);
	if (createOnly) {
		await writeFile(path, `${JSON.stringify(state)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		return;
	}
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	await rename(temporary, path);
}
async function load(
	home: string,
	resource: string,
	ref: string,
): Promise<StoredAuthMdState> {
	const path = statePath(home, resource, ref);
	if ((await stat(path)).mode & 0o077)
		throw new Error("auth.md credential file must be owner-only");
	const raw = JSON.parse(await readFile(path, "utf8"));
	if (
		!isJsonObject(raw) ||
		raw.schemaVersion !== "hobo.cli-authmd/v1" ||
		raw.resource !== parseHttpsUrl(resource) ||
		raw.registrationRef !== ref ||
		!isJsonString(raw.privateKey)
	)
		throw new Error("Invalid or mismatched auth.md credential record");
	// SAFETY: this owner-only record is re-parsed through library binding/scope/time constructors before credential use.
	const binding = parseBinding(raw.binding);
	const state: StoredAuthMdState = {
		schemaVersion: "hobo.cli-authmd/v1",
		resource: parseHttpsUrl(raw.resource),
		registrationRef: parseRegistrationRef(raw.registrationRef),
		binding,
		preClaimScopes: parseScopes(raw.preClaimScopes),
		privateKey: raw.privateKey,
		issuedAt: parseInstant(raw.issuedAt),
		...(raw.expiresAt === undefined
			? undefined
			: { expiresAt: parseInstant(raw.expiresAt) }),
		...(raw.claimEndpoint === undefined
			? undefined
			: { claimEndpoint: parseHttpsUrl(raw.claimEndpoint) }),
		...(raw.rotationEndpoint === undefined
			? undefined
			: { rotationEndpoint: parseHttpsUrl(raw.rotationEndpoint) }),
		...(raw.revocationEndpoint === undefined
			? undefined
			: { revocationEndpoint: parseHttpsUrl(raw.revocationEndpoint) }),
		...(raw.revoked === undefined
			? undefined
			: {
					revoked: { revokedAt: parseInstant(object(raw.revoked).revokedAt) },
				}),
		...(raw.deployments === undefined
			? undefined
			: { deployments: strings(raw.deployments) }),
		...(raw.ownedDeployments === undefined
			? undefined
			: { ownedDeployments: strings(raw.ownedDeployments) }),
		...(raw.principal === undefined
			? undefined
			: { principal: parsePrincipal(object(raw.principal)) }),
		...(raw.initiation === undefined
			? undefined
			: { initiation: parseInitiation(object(raw.initiation)) }),
	};
	const parsed = registration(state);
	if (!state.revoked && state.privateKey.length === 0)
		throw new Error("Active auth.md credential record has no key material");
	const principal = state.principal;
	if (
		principal &&
		(principal.registrationRef !== parsed.registrationRef ||
			!sessionBindingsMatch(principal.binding, parsed.binding) ||
			!scopesSubsetOf(principal.preClaimScopes, parsed.preClaimScopes) ||
			!scopesSubsetOf(parsed.preClaimScopes, principal.preClaimScopes) ||
			!scopesSubsetOf(principal.postClaimScopes, parsed.preClaimScopes))
	)
		throw new Error(
			"Stored auth.md principal does not match registration binding and scopes",
		);
	if (
		state.initiation &&
		(state.initiation.registrationRef !== parsed.registrationRef ||
			!scopesSubsetOf(
				state.initiation.requestedPostClaimScopes,
				parsed.preClaimScopes,
			))
	)
		throw new Error("Stored auth.md claim does not match registration");
	if (state.ownedDeployments?.some((id) => !state.deployments?.includes(id)))
		throw new Error("Stored infrastructure claim lacks its deployment binding");
	return state;
}
function registration(state: StoredAuthMdState): AgentRegistration {
	return {
		registrationRef: parseRegistrationRef(state.registrationRef),
		binding: parseSessionBinding(state.binding),
		preClaimScopes: parseScopes(state.preClaimScopes),
		keyMaterial: createSensitive(
			"agent-private-key",
			state.privateKey,
			materialHandle(state.resource, state.registrationRef),
		),
		issuedAt: parseInstant(state.issuedAt),
		phase: "pre-claim",
		...(state.expiresAt === undefined
			? undefined
			: { expiresAt: parseInstant(state.expiresAt) }),
		...(state.claimEndpoint === undefined
			? undefined
			: { claimEndpoint: parseHttpsUrl(state.claimEndpoint) }),
	};
}
function publicState(state: StoredAuthMdState): JsonObject {
	return asJsonObject({
		registrationRef: state.registrationRef,
		resource: state.resource,
		binding: state.binding,
		phase: state.revoked ? "revoked" : (state.principal?.phase ?? "pre-claim"),
		preClaimScopes: state.preClaimScopes,
		postClaimScopes: state.principal?.postClaimScopes ?? [],
		humanSubject: state.principal?.humanSubject ?? null,
		rotationSatisfied: state.principal?.rotationSatisfied ?? false,
		infrastructureOwnership: "independent",
		infrastructurePhase:
			(state.ownedDeployments?.length ?? 0) > 0
				? "owner-controlled"
				: (state.deployments?.length ?? 0) > 0
					? "temporary"
					: "unbound",
		expiresAt: state.expiresAt ?? null,
	});
}
async function append(
	store: EventStore,
	state: StoredAuthMdState,
	event: AgentPrincipalEvent,
): Promise<void> {
	const stream = `authmd:${JSON.stringify([state.binding.tenantId, state.binding.projectId, state.resource, state.registrationRef])}`;
	let sequence = 0;
	for await (const stored of store.read(stream)) sequence = stored.seq;
	await store.append(stream, [{ type: event.type, data: cloneAsJson(event) }], {
		expectedSeq: sequence,
		tenant: state.binding.tenantId,
		project: state.binding.projectId,
		actor: { kind: "agent", id: state.registrationRef },
	});
}

/** Return a short-lived authenticated resource credential for a matching local registration. */
export async function presentAuthMdCredential(input: {
	readonly hoboHome: string;
	readonly resource: string;
	readonly metadataUrl?: string;
	readonly tenant?: string;
	readonly project?: string;
	readonly registrationRef?: string;
	readonly operationUrl?: string;
	readonly fetchImpl?: typeof fetch;
	readonly lifecycle?: boolean;
}): Promise<PresentedCredential | null> {
	return withAuthMdLock(input.hoboHome, () =>
		presentAuthMdCredentialUnlocked(input),
	);
}

async function presentAuthMdCredentialUnlocked(
	input: Parameters<typeof presentAuthMdCredential>[0],
): Promise<PresentedCredential | null> {
	let files: string[];
	try {
		files = await readdir(directory(input.hoboHome));
	} catch {
		return null;
	}
	const port: HttpPort = { fetchImpl: input.fetchImpl ?? fetch };
	const discovery = await discoverAuthMdForLifecycle({
		port,
		resource: input.resource,
		...(input.registrationRef === undefined
			? undefined
			: { expectedResource: input.resource }),
		...(input.metadataUrl === undefined
			? undefined
			: { metadataUrl: input.metadataUrl }),
	});
	const resource = discovery.metadata.resource;
	if (new URL(resource).origin !== new URL(input.resource).origin)
		throw new Error(
			"auth.md metadata resource is outside the selected broker origin",
		);
	if (input.operationUrl !== undefined) {
		const operation = new URL(input.operationUrl);
		const protectedResource = new URL(resource);
		const prefix = protectedResource.pathname.replace(/\/+$/u, "");
		if (
			operation.origin !== protectedResource.origin ||
			(prefix !== "" &&
				operation.pathname !== prefix &&
				!operation.pathname.startsWith(`${prefix}/`))
		)
			throw new Error(
				"deployment endpoint is outside the registered auth.md protected resource",
			);
	}
	const candidates: StoredAuthMdState[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		const raw = JSON.parse(
			await readFile(join(directory(input.hoboHome), file), "utf8"),
		);
		if (
			!isJsonObject(raw) ||
			raw.resource !== resource ||
			!isJsonString(raw.registrationRef)
		)
			continue;
		const state = await load(input.hoboHome, resource, raw.registrationRef);
		if (
			input.registrationRef !== undefined &&
			state.registrationRef !== input.registrationRef
		)
			continue;
		if (input.tenant !== undefined && state.binding.tenantId !== input.tenant)
			continue;
		if (
			input.project !== undefined &&
			state.binding.projectId !== input.project
		)
			continue;
		candidates.push(state);
	}
	if (candidates.length > 1)
		throw new Error(
			"Multiple auth.md registrations match; select the intended tenant/project/registration",
		);
	const state = candidates[0];
	if (!state) return null;
	if (state.revoked)
		throw new Error("The auth.md agent registration is revoked");
	if (!input.lifecycle && (state.ownedDeployments?.length ?? 0) > 0) {
		if (!state.principal)
			throw new Error(
				"Claim the agent principal and rotate credentials before managing owner-controlled infrastructure",
			);
		assertManagementAccess({
			principal: state.principal,
			infrastructure: "owner-controlled",
		});
	}
	const token = await exchangeAgentAccessToken({
		port,
		discovery,
		registration: registration(state),
		...(state.principal === undefined
			? undefined
			: { principal: state.principal }),
	});
	return {
		scheme: "bearer-session",
		principal: { kind: "agent", id: state.registrationRef },
		tenant: state.binding.tenantId,
		accessToken: discloseSensitive(token.accessToken),
		audience: state.binding.audience,
		expiresAt: token.expiresAt,
		metadata: {
			protocol: "auth.md",
			registrationRef: state.registrationRef,
			resource: state.resource,
		},
	};
}

/** Keep human login and migration commands intact while exposing the agent plane. */
export function createAuthMdIdentityCommand(
	deps: AuthMdIdentityCommandDeps,
): CommandModule {
	return {
		implemented: true,
		async run(input) {
			if (input.args[0] !== "agent") return deps.fallback.run(input);
			const [, operation, first, ref] = input.args;
			const env = deps.env ?? process.env;
			const home =
				isJsonString(input.flags.home) && input.flags.home.length > 0
					? input.flags.home
					: (env.HOBO_HOME ?? defaultHoboHome(env));
			const port: HttpPort = { fetchImpl: deps.fetchImpl ?? fetch };
			const ownedStore = deps.store === undefined;
			const store =
				deps.store ??
				createRuntimeLocalEventStore({
					dataDir: join(home, "auth-md", "events"),
				});
			let releaseLock: (() => void) | undefined;
			try {
				releaseLock = await acquireAuthMdLock(home);
				if (operation === "discover") {
					const discovery = await discoverAuthMdForLifecycle({
						port,
						resource: required(first, "resource"),
					});
					return {
						ok: true,
						status: "discovered",
						code: "HOBO_OK",
						message: "auth.md resource metadata discovered",
						data: asJsonObject(discovery),
					};
				}
				if (operation === "register") {
					const config = JSON.parse(
						await readFile(
							resolve(
								input.context.cwd,
								required(first, "registration config"),
							),
							"utf8",
						),
					);
					if (
						!isJsonObject(config) ||
						!isJsonString(config.resource) ||
						!isJsonObject(config.binding)
					)
						throw new Error(
							"Auth.md registration config requires resource, binding, and requestedScopes",
						);
					const resource = parseHttpsUrl(config.resource);
					// SAFETY: the domain constructor validates every persisted binding dimension at this configuration boundary.
					const binding = parseSessionBinding(parseBinding(config.binding));
					const discovery = await discoverAuthMdForLifecycle({
						port,
						resource,
					});
					const { registerAnonymousAgent } = await import("@hobo/auth-md");
					const registered = await registerAnonymousAgent({
						port,
						discovery,
						binding,
						requestedScopes: parseScopes(config.requestedScopes),
					});
					const state: StoredAuthMdState = {
						schemaVersion: "hobo.cli-authmd/v1",
						resource: discovery.metadata.resource,
						registrationRef: registered.registrationRef,
						binding,
						privateKey: discloseSensitive(registered.keyMaterial),
						preClaimScopes: registered.preClaimScopes,
						issuedAt: registered.issuedAt,
						...(registered.expiresAt === undefined
							? undefined
							: { expiresAt: registered.expiresAt }),
						...(registered.claimEndpoint === undefined
							? undefined
							: { claimEndpoint: registered.claimEndpoint }),
						...(registered.rotationEndpoint === undefined
							? undefined
							: { rotationEndpoint: registered.rotationEndpoint }),
						...(registered.revocationEndpoint === undefined
							? undefined
							: { revocationEndpoint: registered.revocationEndpoint }),
					};
					await save(home, state, true);
					await append(store, state, agentRegisteredEvent(registered));
					return {
						ok: true,
						status: "registered",
						code: "HOBO_OK",
						message:
							"Anonymous agent registered; infrastructure ownership is unchanged",
						data: publicState(state),
					};
				}
				const resource = parseHttpsUrl(required(first, "resource"));
				const state = await load(
					home,
					resource,
					required(ref, "registration reference"),
				);
				if (operation === "status")
					return {
						ok: true,
						status: "ok",
						code: "HOBO_OK",
						message: "auth.md agent status",
						data: publicState(state),
					};
				if (state.revoked)
					throw new Error("The auth.md agent registration is revoked");
				if (operation === "claim") {
					const initiation = await initiateHumanClaim({
						port,
						registration: registration(state),
						requestedPostClaimScopes: parseScopes(state.preClaimScopes),
					});
					await save(home, {
						...state,
						initiation: {
							registrationRef: initiation.registrationRef,
							claimUrl: initiation.claimUrl,
							pollEndpoint: initiation.pollEndpoint,
							expiresAt: initiation.expiresAt,
							intervalSeconds: initiation.intervalSeconds,
							requestedPostClaimScopes: initiation.requestedPostClaimScopes,
							pollMaterial: discloseSensitive(initiation.pollToken),
						},
					});
					await append(
						store,
						state,
						claimInitiatedEvent(initiation, instantFrom(new Date())),
					);
					return {
						ok: true,
						status: "claim_pending",
						code: "HOBO_OK",
						message:
							"Human agent-principal claim initiated; infrastructure ownership is unchanged",
						data: {
							registrationRef: state.registrationRef,
							claimUrl: initiation.claimUrl,
							expiresAt: initiation.expiresAt,
						},
					};
				}
				if (operation === "poll") {
					if (!state.initiation)
						throw new Error("Initiate the agent claim before polling");
					const initiation: ClaimInitiation = {
						...state.initiation,
						pollToken: createSensitive(
							"claim-token",
							state.initiation.pollMaterial,
							materialHandle(state.registrationRef, state.initiation.expiresAt),
						),
					};
					const result = await pollHumanClaim({
						port,
						registration: registration(state),
						initiation,
					});
					if (result.status === "pending")
						return {
							ok: true,
							status: "claim_pending",
							code: "HOBO_OK",
							message: "Human agent claim is pending",
							data: asJsonObject(result),
						};
					const updated = { ...state, principal: result.principal };
					await save(home, updated);
					await append(store, state, principalClaimedEvent(result.principal));
					return {
						ok: true,
						status: "claimed",
						code: "HOBO_OK",
						message:
							"Agent principal claimed; infrastructure ownership is unchanged",
						data: publicState(updated),
					};
				}
				if (operation === "rotate" || operation === "revoke") {
					if (state.revoked)
						throw new Error("The auth.md agent is already revoked");
					if (operation === "rotate" && !state.principal)
						throw new Error(
							"Claim the agent principal before credential rotation",
						);
					const credential = await presentAuthMdCredentialUnlocked({
						hoboHome: home,
						resource,
						registrationRef: state.registrationRef,
						fetchImpl: port.fetchImpl,
						lifecycle: true,
					});
					if (!credential) throw new Error("No matching auth.md credential");
					const call = async (
						endpoint: string | undefined,
						body: JsonObject,
					) => {
						if (!endpoint)
							throw new Error(
								"The registration did not advertise this credential lifecycle endpoint",
							);
						if (new URL(endpoint).origin !== new URL(resource).origin)
							throw new Error(
								"Credential lifecycle endpoint is outside the registered resource origin",
							);
						return object(
							cloneAsJson(
								await requestJson(port, endpoint, {
									method: "POST",
									rejectRedirects: true,
									headers: {
										authorization: `Bearer ${credential.accessToken}`,
									},
									jsonBody: body,
								}),
							),
						);
					};
					const rotationPort: RotationPort = {
						id: "auth.md-advertised-http",
						async rotate(value) {
							const response = await call(state.rotationEndpoint, {
								registration_ref: value.registrationRef,
								binding: asJsonObject(value.binding),
								reason: value.reason,
							});
							return { material: textValue(response.private_key) };
						},
						async revoke(value) {
							await call(state.revocationEndpoint, {
								registration_ref: value.registrationRef,
								reason: value.reason,
							});
							return {};
						},
					};
					const current = registration(state);
					const now = instantFrom(new Date());
					if (operation === "revoke") {
						const revoked = await revokeAgentPrincipal({
							port: rotationPort,
							principal: state.principal ?? current,
							keyMaterial: current.keyMaterial,
							reason: "operator",
						});
						const updated = {
							...state,
							privateKey: "",
							revoked: { revokedAt: revoked.revokedAt },
						};
						await save(home, updated);
						await append(store, state, {
							type: "authmd.PrincipalRevoked",
							registrationRef: current.registrationRef,
							occurredAt: now,
							phase: "revoked",
							scopes: [],
						});
						return {
							ok: true,
							status: "revoked",
							code: "HOBO_OK",
							message:
								"Agent registration revoked; human login and infrastructure ownership unchanged",
							data: publicState(updated),
						};
					}
					if (!state.principal)
						throw new Error(
							"Claim the agent principal before credential rotation",
						);
					const outcome = await rotateAgentCredentials({
						port: rotationPort,
						principal: state.principal,
						currentKeyMaterial: current.keyMaterial,
						reason: "operator",
					});
					const updated = {
						...state,
						privateKey: discloseSensitive(outcome.keyMaterial),
						principal: outcome.principal,
					};
					// Persist the server's replacement before verification so failures can be retried without resurrecting the superseded key.
					await save(home, {
						...updated,
						principal: { ...outcome.principal, rotationSatisfied: false },
					});
					const discovery = await discoverAuthMdForLifecycle({
						port,
						resource,
						expectedResource: state.resource,
					});
					await exchangeAgentAccessToken({
						port,
						discovery,
						registration: registration(updated),
						principal: outcome.principal,
					});
					await save(home, updated);
					await append(store, state, {
						type: "authmd.CredentialsRotated",
						registrationRef: current.registrationRef,
						occurredAt: now,
						phase: "human-bound",
						scopes: state.principal.postClaimScopes,
					});
					return {
						ok: true,
						status: "rotated",
						code: "HOBO_OK",
						message: "Agent credentials rotated and replacement proof verified",
						data: publicState(updated),
					};
				}
				if (operation === "token") {
					const credential = await presentAuthMdCredentialUnlocked({
						hoboHome: home,
						resource,
						registrationRef: state.registrationRef,
						fetchImpl: port.fetchImpl,
					});
					if (!credential) throw new Error("No matching agent registration");
					return {
						ok: true,
						status: "token_exchanged",
						code: "HOBO_OK",
						message: "Agent proof exchanged for a resource token",
						data: {
							registrationRef: credential.principal.id,
							audience: credential.audience,
							expiresAt: credential.expiresAt,
						},
					};
				}
				throw new Error(
					"Use identity agent discover|register|status|claim|poll|token|rotate|revoke",
				);
			} catch (error) {
				return {
					ok: false,
					status: "error",
					code: "HOBO_AUTHMD_FAILED",
					message: redactText(
						error instanceof Error ? error.message : "auth.md operation failed",
					),
					data: { command: "identity", plane: "auth.md" },
				};
			} finally {
				releaseLock?.();
				if (ownedStore && "close" in store && store.close instanceof Function)
					store.close();
			}
		},
	};
}

/** Record the exact registration that authenticated a successful deployment. */
export async function recordAuthMdDeployment(
	home: string,
	credential: PresentedCredential,
	deploymentId: string,
): Promise<void> {
	if (credential.metadata?.protocol !== "auth.md") return;
	const resource = textValue(credential.metadata.resource);
	await withAuthMdLock(home, async () => {
		const state = await load(home, resource, credential.principal.id);
		await save(home, {
			...state,
			deployments: [...new Set([...(state.deployments ?? []), deploymentId])],
		});
	});
}
/** Actual infrastructure claim changes only the management gate, never the agent identity or scopes. */
export async function markAuthMdInfrastructureClaim(
	home: string,
	brokerUri: string,
	deploymentId: string,
): Promise<void> {
	return withAuthMdLock(home, () =>
		markAuthMdInfrastructureClaimUnlocked(home, brokerUri, deploymentId),
	);
}
async function markAuthMdInfrastructureClaimUnlocked(
	home: string,
	brokerUri: string,
	deploymentId: string,
): Promise<void> {
	let files: string[];
	try {
		files = await readdir(directory(home));
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const raw = object(
			JSON.parse(await readFile(join(directory(home), file), "utf8")),
		);
		if (new URL(textValue(raw.resource)).origin !== new URL(brokerUri).origin)
			continue;
		const state = await load(
			home,
			textValue(raw.resource),
			textValue(raw.registrationRef),
		);
		if (
			!state.deployments?.includes(deploymentId) ||
			state.ownedDeployments?.includes(deploymentId)
		)
			continue;
		await save(home, {
			...state,
			ownedDeployments: [...(state.ownedDeployments ?? []), deploymentId],
			...(state.principal === undefined
				? undefined
				: { principal: { ...state.principal, rotationSatisfied: false } }),
		});
	}
}
