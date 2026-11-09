import { randomUUID } from "node:crypto";
import {
	clone,
	create,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	AccountSchema,
	AccountStateSchema,
	BudgetSignalSchema,
	type CiEvent,
	type Configuration,
	ConfigurationSchema,
	type ConfigurationState,
	ConnectionSchema,
	type ControlRecord,
	ciBudgetPolicyJson,
	ciBudgetSignalUpdate,
	DesiredCiPolicySchema,
	effectiveCiAccount,
	LeaseSchema,
	OfferSchema,
	parseCiPolicy,
	parseConfiguration,
	ReconcileRequestSchema,
	RepositorySetupRequestSchema,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
	SnapshotSchema,
} from "@hobo/ci";
import { z } from "zod";
import type {
	ControlAuthenticator,
	ControlPrincipal,
} from "./control-plane.js";
import type { HostedRelay, HostedRelayStore } from "./hosted-relay.js";
import {
	IsolatedOnboardingError,
	prepareIsolatedConnection,
} from "./isolated-onboarding.js";
import {
	applyOnboarding,
	connectRepository,
	type OnboardingGithubPort,
	type OnboardingOperation,
	OnboardingOperationSchema,
	OnboardingPendingError,
	OnboardingPlanSchema,
	OnboardingPrincipalSchema,
	parseOnboardingPlan,
	prepareOnboarding,
} from "./onboarding.js";

interface HostedControlStore extends HostedRelayStore {
	reattestRate(
		input: {
			accountId: string;
			offerId: string;
			checkedAt: string;
			validUntil: string;
			sourceUrl: string;
		},
		revision: number,
		at: string,
	): Promise<ConfigurationState>;
	configure(
		config: Configuration,
		revision: number,
		at: string,
	): Promise<ConfigurationState>;
	configureWithRecord(
		config: Configuration,
		revision: number,
		at: string,
		key: string,
		accountId: string,
		bodyJson: string,
	): Promise<ConfigurationState>;
	controlRecord(key: string): Promise<ControlRecord | undefined>;
	putControlRecordMonotonic(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
		terminalStatus: string,
	): Promise<ControlRecord | undefined>;
	events(): Promise<CiEvent[]>;
	quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<
		Array<{
			deliveryId: string;
			event: string;
			installationId: number;
			repositoryId: number;
			receivedAt: string;
			attempts: number;
		}>
	>;
	retryQuarantinedWebhook(
		accountId: string,
		expectedRevision: number,
		deliveryId: string,
	): Promise<boolean>;
}
class ControlError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
function response(status: number, value: string, revision?: number): Response {
	const headers = new Headers({
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	if (revision !== undefined) headers.set("etag", `"${revision}"`);
	return new Response(value, { status, headers });
}
async function readBody(request: Request): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		size += part.value.byteLength;
		if (size > 1024 * 1024) {
			await reader.cancel();
			throw new ControlError(413, "request body too large");
		}
		chunks.push(part.value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function revision(request: Request): number {
	const value = request.headers.get("if-match");
	if (!value || !/^(?:\d+|"\d+")$/.test(value))
		throw new ControlError(428, "If-Match configuration revision required");
	const parsed = Number(value.replaceAll('"', ""));
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new ControlError(400, "invalid configuration revision");
	return parsed;
}

/** A newer policy revision does not make an older financial snapshot current. */
function requireFreshObservation(
	previousAt: string,
	incomingAt: string,
	unchanged: boolean,
	now: string,
): void {
	if (!incomingAt) {
		if (previousAt || !unchanged)
			throw new ControlError(409, "financial observation timestamp required");
		return;
	}
	const incomingTime = Date.parse(incomingAt);
	const previousTime = previousAt ? Date.parse(previousAt) : undefined;
	if (
		!Number.isFinite(incomingTime) ||
		incomingTime > Date.parse(now) ||
		(previousTime !== undefined &&
			(incomingTime < previousTime ||
				(incomingTime === previousTime && !unchanged)))
	)
		throw new ControlError(409, "stale or conflicting financial observation");
}
function policyState(state: ConfigurationState, accountId: string): string {
	const config = state.configuration;
	if (!config) throw new ControlError(503, "configuration unavailable");
	const account = config.accounts.find((entry) => entry.id === accountId);
	const result = create(AccountStateSchema, {
		revision: state.revision,
		connections: config.connections.filter(
			(entry) => entry.accountId === accountId,
		),
		updatedAt: state.updatedAt,
	});
	if (account) result.account = account;
	return toJsonString(AccountStateSchema, result);
}

/** Account-scoped async control plane for a durable hosted relay. */
export function createHostedControlPlane(options: {
	relay: HostedRelay;
	store: HostedControlStore;
	github: OnboardingGithubPort;
	authenticate: ControlAuthenticator;
	publicOrigin: string;
	assets: { workflow: string; bootstrap: string };
	runtimeDiagnostic?: () => {
		sandboxEnabled: boolean;
		allowedDomains: readonly string[];
		deploymentId: string | null;
	};
}) {
	const { store, relay } = options;
	async function state(): Promise<ConfigurationState> {
		const result = await store.configuration();
		if (!result?.configuration)
			throw new ControlError(503, "configuration unavailable");
		return result;
	}
	async function scope(
		principal: ControlPrincipal,
		repositoryId: number,
		repository: string,
		installationId: number,
	) {
		if (!principal.installationIds.includes(installationId))
			throw new ControlError(
				403,
				"GitHub installation is not bound to this account",
			);
		const config = (await state()).configuration;
		if (
			config?.connections.some(
				(entry) =>
					(entry.repositoryId === repositoryId ||
						entry.repository.toLowerCase() === repository.toLowerCase()) &&
					entry.accountId !== principal.accountId,
			)
		)
			throw new ControlError(409, "repository belongs to another account");
	}
	async function operation(id: string, accountId: string) {
		const record = await store.controlRecord(`onboarding:${id}`);
		if (!record || record.accountId !== accountId)
			throw new ControlError(404, "setup operation not found");
		return fromJsonString(OnboardingOperationSchema, record.bodyJson);
	}
	async function record(op: OnboardingOperation, accountId: string) {
		const saved = await store.putControlRecordMonotonic(
			`onboarding:${op.id}`,
			accountId,
			toJsonString(OnboardingOperationSchema, op),
			relay.now(),
			"ready",
		);
		if (!saved) throw new Error("operation commit missing");
		return fromJsonString(OnboardingOperationSchema, saved.bodyJson);
	}
	return async (request: Request): Promise<Response | undefined> => {
		const path = new URL(request.url).pathname;
		if (
			!path.startsWith("/v1/accounts/self/") &&
			!path.startsWith("/v2/accounts/self/")
		)
			return undefined;
		try {
			const principal = await options.authenticate(
				request.headers.get("authorization") ?? undefined,
			);
			if (!principal)
				throw new ControlError(401, "account authentication required");
			const required = path.startsWith("/v2/accounts/self/inbox/")
				? "operations:write"
				: request.method === "GET"
					? path === "/v2/accounts/self/signals"
						? "observations:write"
						: "policy:read"
					: path.endsWith("/observations") ||
							path.endsWith("/rate-observations") ||
							path.endsWith("/signals")
						? "observations:write"
						: path.includes("/repositories/")
							? "repositories:write"
							: path.includes("/leases/")
								? "operations:write"
								: "policy:write";
			if (!principal.scopes.includes(required))
				throw new ControlError(403, "account scope required");
			if (path === "/v2/accounts/self/runtime" && request.method === "GET") {
				if (!options.runtimeDiagnostic)
					throw new ControlError(404, "runtime diagnostic unavailable");
				const current = await state();
				if (
					!current.configuration?.accounts.some(
						(account) => account.id === principal.accountId,
					)
				)
					throw new ControlError(404, "account not found");
				return response(200, JSON.stringify(options.runtimeDiagnostic()));
			}
			if (
				path === "/v1/accounts/self/installations" &&
				request.method === "GET"
			)
				return response(
					200,
					toJsonString(
						OnboardingPrincipalSchema,
						create(OnboardingPrincipalSchema, {
							accountId: principal.accountId,
							installationIds: principal.installationIds,
						}),
					),
				);
			if (path === "/v1/accounts/self/policy" && request.method === "GET") {
				const current = await state();
				return response(
					200,
					policyState(current, principal.accountId),
					current.revision,
				);
			}
			if (path === "/v1/accounts/self/policy" && request.method === "PUT")
				throw new ControlError(
					410,
					"use v2 desired policy; full account updates are disabled",
				);
			if (path === "/v2/accounts/self/policy" && request.method === "PUT") {
				const expected = revision(request);
				const desired = parseCiPolicy(await readBody(request));
				if (desired.accountId !== principal.accountId)
					throw new ControlError(
						403,
						"account policy belongs to another account",
					);
				const current = await state();
				const config = current.configuration;
				if (!config || current.revision !== expected)
					throw new ControlError(409, "configuration revision conflict");
				const account = config.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				if (!account)
					throw new ControlError(409, "trusted account bootstrap required");
				if (desired.providers.length !== account.offers.length)
					throw new ControlError(
						409,
						"provider inventory requires trusted provisioning",
					);
				for (const provider of desired.providers) {
					const offer = account.offers.find(
						(entry) => entry.id === provider.id,
					);
					if (
						!offer ||
						offer.provider !== provider.kind ||
						offer.providerAccountId !== provider.connectionRef ||
						offer.runsOn !== provider.runsOn ||
						(provider.kind === "vercel"
							? offer.backend !== "sandbox"
							: !!offer.backend && offer.backend !== "gh-actions")
					)
						throw new ControlError(
							409,
							"provider binding requires trusted provisioning",
						);
				}
				if (!desired.budget) throw new ControlError(400, "budget required");
				if (account.budgetPolicy && !desired.budgetPolicy)
					throw new ControlError(400, "common budget policy cannot be removed");
				const effective = effectiveCiAccount(
					{ ...account, budgetMicros: desired.budget.limitMicros },
					desired,
				);
				account.budgetMicros = effective.budgetMicros;
				account.budgetPolicy = desired.budgetPolicy;
				account.routingStrategy = effective.routingStrategy;
				parseConfiguration(toJsonString(ConfigurationSchema, config));
				const saved = await store.configureWithRecord(
					config,
					expected,
					relay.now(),
					`ci-policy:${principal.accountId}`,
					principal.accountId,
					toJsonString(DesiredCiPolicySchema, desired),
				);
				return response(
					200,
					policyState(saved, principal.accountId),
					saved.revision,
				);
			}
			if (path === "/v2/accounts/self/providers" && request.method === "PUT") {
				const expected = revision(request);
				const incoming = fromJsonString(OfferSchema, await readBody(request));
				const current = await state();
				const config = current.configuration;
				if (!config || current.revision !== expected)
					throw new ControlError(409, "configuration revision conflict");
				const account = config.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				if (!account) throw new ControlError(404, "account not found");
				const offer = account.offers.find((entry) => entry.id === incoming.id);
				if (!offer) throw new ControlError(404, "provider offer not found");
				const next = clone(OfferSchema, offer);
				next.budgetMicros = incoming.budgetMicros;
				next.concurrency = incoming.concurrency;
				if (next.budgetMicros > account.budgetMicros)
					throw new ControlError(400, "provider budget exceeds account budget");
				if (
					next.sandboxPricing &&
					incoming.sandboxPricing &&
					incoming.sandboxPricing.bootstrapFixedMicros <
						next.sandboxPricing.bootstrapFixedMicros
				)
					throw new ControlError(
						403,
						"bootstrap estimate cannot be lowered through provider policy",
					);
				if (next.sandboxPricing && incoming.sandboxPricing)
					next.sandboxPricing.bootstrapFixedMicros =
						incoming.sandboxPricing.bootstrapFixedMicros;
				if (
					toJsonString(OfferSchema, next) !==
					toJsonString(OfferSchema, incoming)
				)
					throw new ControlError(
						400,
						"provider configuration cannot change binding or usage evidence",
					);
				const index = account.offers.findIndex(
					(entry) => entry.id === offer.id,
				);
				account.offers[index] = next;
				parseConfiguration(toJsonString(ConfigurationSchema, config));
				const saved = await store.configure(config, expected, relay.now());
				return response(
					200,
					policyState(saved, principal.accountId),
					saved.revision,
				);
			}
			if (path === "/v2/accounts/self/signals" && request.method === "GET") {
				const current = await state();
				return response(
					200,
					policyState(current, principal.accountId),
					current.revision,
				);
			}
			if (path === "/v2/accounts/self/signals" && request.method === "POST") {
				const expected = revision(request);
				const signal = fromJsonString(
					BudgetSignalSchema,
					await readBody(request),
				);
				const current = await state();
				if (current.revision !== expected || !current.configuration)
					throw new ControlError(409, "configuration revision conflict");
				const account = current.configuration.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				const record = await store.controlRecord(
					`ci-policy:${principal.accountId}`,
				);
				if (!account || !record || record.accountId !== principal.accountId)
					throw new ControlError(
						409,
						"desired policy is required before budget signals",
					);
				const policy = parseCiPolicy(record.bodyJson);
				if (
					ciBudgetPolicyJson(account.budgetPolicy) !==
					ciBudgetPolicyJson(policy.budgetPolicy)
				)
					throw new ControlError(409, "desired and active budget scope differ");
				let update: ReturnType<typeof ciBudgetSignalUpdate>;
				try {
					update = ciBudgetSignalUpdate(signal, policy);
				} catch {
					throw new ControlError(400, "invalid or foreign budget signal");
				}
				if (
					update.watermark <= (account.routingSignalCycles[update.key] ?? 0)
				) {
					const latest = await state();
					if (latest.revision !== expected)
						throw new ControlError(409, "configuration revision conflict");
					return response(
						200,
						policyState(latest, principal.accountId),
						latest.revision,
					);
				}
				account.routingSignalCycles[update.key] = update.watermark;
				account.routingSignalCrossed[update.key] = update.crossed;
				const saved = await store.configure(
					current.configuration,
					expected,
					relay.now(),
				);
				return response(
					200,
					policyState(saved, principal.accountId),
					saved.revision,
				);
			}
			if (
				path === "/v2/accounts/self/rate-observations" &&
				request.method === "POST"
			) {
				const expected = revision(request);
				const input = z
					.object({
						offerId: z.string().min(1).max(100),
						checkedAt: z.string().min(1).max(40),
						validUntil: z.string().min(1).max(40),
						sourceUrl: z.string().min(1).max(2048),
					})
					.strict()
					.parse(JSON.parse(await readBody(request)));
				const saved = await store.reattestRate(
					{ ...input, accountId: principal.accountId },
					expected,
					relay.now(),
				);
				return response(
					200,
					policyState(saved, principal.accountId),
					saved.revision,
				);
			}
			if (
				path === "/v2/accounts/self/observations" &&
				request.method === "POST"
			) {
				const expected = revision(request);
				const incoming = fromJsonString(AccountSchema, await readBody(request));
				if (incoming.id !== principal.accountId)
					throw new ControlError(
						403,
						"account observation belongs to another account",
					);
				const current = await state();
				const config = current.configuration;
				if (!config || current.revision !== expected)
					throw new ControlError(409, "configuration revision conflict");
				const account = config.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				if (
					!account ||
					incoming.offers.length !== account.offers.length ||
					new Set(incoming.offers.map((offer) => offer.id)).size !==
						incoming.offers.length
				)
					throw new ControlError(
						409,
						"provider inventory requires trusted provisioning",
					);
				if (
					incoming.budgetMicros !== account.budgetMicros ||
					incoming.routingStrategy !== account.routingStrategy ||
					ciBudgetPolicyJson(incoming.budgetPolicy) !==
						ciBudgetPolicyJson(account.budgetPolicy) ||
					incoming.maxRuntimeMinutes !== account.maxRuntimeMinutes ||
					incoming.startupMinutes !== account.startupMinutes ||
					JSON.stringify(
						Object.entries(incoming.routingSignalCycles).sort(),
					) !==
						JSON.stringify(
							Object.entries(account.routingSignalCycles).sort(),
						) ||
					JSON.stringify(
						Object.entries(incoming.routingSignalCrossed).sort(),
					) !==
						JSON.stringify(Object.entries(account.routingSignalCrossed).sort())
				)
					throw new ControlError(
						400,
						"observation cannot change policy or signal state",
					);
				requireFreshObservation(
					account.usageObservedAt,
					incoming.usageObservedAt,
					account.spentMicros === incoming.spentMicros,
					relay.now(),
				);
				for (const observation of incoming.offers) {
					const offer = account.offers.find(
						(entry) => entry.id === observation.id,
					);
					if (
						!offer ||
						offer.provider !== observation.provider ||
						offer.providerAccountId !== observation.providerAccountId ||
						offer.enabled !== observation.enabled ||
						offer.runsOn !== observation.runsOn ||
						offer.budgetMicros !== observation.budgetMicros ||
						offer.concurrency !== observation.concurrency ||
						offer.bridgeAcknowledged !== observation.bridgeAcknowledged ||
						offer.backend !== observation.backend
					)
						throw new ControlError(
							400,
							"observation cannot change provider policy or binding",
						);
					if (
						Boolean(offer.sandboxPricing) !==
							Boolean(observation.sandboxPricing) ||
						(offer.sandboxPricing &&
							observation.sandboxPricing &&
							(offer.sandboxPricing.vcpus !==
								observation.sandboxPricing.vcpus ||
								offer.sandboxPricing.memoryMb !==
									observation.sandboxPricing.memoryMb ||
								offer.sandboxPricing.maxEgressBytes !==
									observation.sandboxPricing.maxEgressBytes ||
								offer.sandboxPricing.networkHeadroomBytes !==
									observation.sandboxPricing.networkHeadroomBytes ||
								offer.sandboxPricing.proxyVmRequired !==
									observation.sandboxPricing.proxyVmRequired ||
								offer.sandboxPricing.proxyVmVcpus !==
									observation.sandboxPricing.proxyVmVcpus ||
								offer.sandboxPricing.proxyVmMemoryMb !==
									observation.sandboxPricing.proxyVmMemoryMb ||
								offer.sandboxPricing.proxyVmExtraMs !==
									observation.sandboxPricing.proxyVmExtraMs ||
								offer.sandboxPricing.proxyVmNetworkBytes !==
									observation.sandboxPricing.proxyVmNetworkBytes ||
								offer.sandboxPricing.proxyVmNetworkHeadroomBytes !==
									observation.sandboxPricing.proxyVmNetworkHeadroomBytes ||
								offer.sandboxPricing.proxyControlMaxCalls !==
									observation.sandboxPricing.proxyControlMaxCalls ||
								offer.sandboxPricing.region !==
									observation.sandboxPricing.region ||
								offer.sandboxPricing.plan !== observation.sandboxPricing.plan))
					)
						throw new ControlError(
							400,
							"observation cannot change sandbox resource policy",
						);
					requireFreshObservation(
						offer.observedAt,
						observation.observedAt,
						offer.freeMinutes === observation.freeMinutes &&
							offer.priceMicrosPerMinute === observation.priceMicrosPerMinute &&
							offer.spentMicros === observation.spentMicros &&
							offer.validUntil === observation.validUntil &&
							offer.sourceUrl === observation.sourceUrl &&
							(offer.sandboxPricing
								? toJsonString(SandboxPricingSchema, offer.sandboxPricing)
								: "") ===
								(observation.sandboxPricing
									? toJsonString(
											SandboxPricingSchema,
											observation.sandboxPricing,
										)
									: "") &&
							(offer.sandboxAllowance
								? toJsonString(SandboxAllowanceSchema, offer.sandboxAllowance)
								: "") ===
								(observation.sandboxAllowance
									? toJsonString(
											SandboxAllowanceSchema,
											observation.sandboxAllowance,
										)
									: ""),
						relay.now(),
					);
					offer.freeMinutes = observation.freeMinutes;
					offer.priceMicrosPerMinute = observation.priceMicrosPerMinute;
					offer.spentMicros = observation.spentMicros;
					offer.observedAt = observation.observedAt;
					offer.validUntil = observation.validUntil;
					offer.sourceUrl = observation.sourceUrl;
					offer.sandboxPricing = observation.sandboxPricing;
					offer.sandboxAllowance = observation.sandboxAllowance;
				}
				account.spentMicros = incoming.spentMicros;
				account.usageObservedAt = incoming.usageObservedAt;
				parseConfiguration(toJsonString(ConfigurationSchema, config));
				const saved = await store.configure(config, expected, relay.now());
				return response(
					200,
					policyState(saved, principal.accountId),
					saved.revision,
				);
			}
			if (
				path === "/v2/accounts/self/inbox/quarantined" &&
				request.method === "GET"
			) {
				const current = await state();
				const deliveries = await store.quarantinedWebhooks(
					principal.accountId,
					current.revision,
				);
				return response(200, JSON.stringify({ deliveries }), current.revision);
			}
			const retry =
				/^\/v2\/accounts\/self\/inbox\/([A-Za-z0-9-]{1,100})\/retry$/.exec(
					path,
				);
			if (retry?.[1] && request.method === "POST") {
				if ((await readBody(request)).trim())
					throw new ControlError(400, "retry request must have an empty body");
				const expected = revision(request);
				const done = await store.retryQuarantinedWebhook(
					principal.accountId,
					expected,
					retry[1],
				);
				if (!done)
					throw new ControlError(404, "quarantined delivery not found");
				return response(200, JSON.stringify({ status: "queued" }), expected);
			}
			if (path === "/v1/accounts/self/leases" && request.method === "GET") {
				const leases = (await store.all())
					.filter((entry) => entry.accountId === principal.accountId)
					.slice(-100);
				const events = (await store.events())
					.filter((entry) => entry.accountId === principal.accountId)
					.slice(-100);
				return response(
					200,
					toJsonString(
						SnapshotSchema,
						create(SnapshotSchema, { leases, events }),
					),
				);
			}
			if (
				path === "/v1/accounts/self/repositories/isolated-connect" &&
				request.method === "POST"
			) {
				const expected = revision(request);
				const before = await state();
				if (before.revision !== expected || !before.configuration)
					throw new ControlError(409, "configuration revision conflict");
				if (
					!before.configuration.accounts.some(
						(entry) => entry.id === principal.accountId,
					)
				)
					throw new ControlError(
						409,
						"create an account policy before connecting a repository",
					);
				const input = fromJsonString(
					RepositorySetupRequestSchema,
					await readBody(request),
				);
				const connection = await prepareIsolatedConnection({
					github: options.github,
					principal,
					input,
					isolatedHostAvailable: !!relay.options.isolatedHost,
				});
				// Remote identity reads may overlap revocation or account policy changes.
				const currentPrincipal = await options.authenticate(
					request.headers.get("authorization") ?? undefined,
				);
				if (
					!currentPrincipal ||
					currentPrincipal.accountId !== principal.accountId ||
					!currentPrincipal.scopes.includes("repositories:write") ||
					!currentPrincipal.installationIds.includes(
						connection.installationId,
					) ||
					!relay.options.isolatedHost
				)
					throw new ControlError(403, "repository authority changed");
				await scope(
					currentPrincipal,
					connection.repositoryId,
					connection.repository,
					connection.installationId,
				);
				const latest = await state();
				if (latest.revision !== expected || !latest.configuration)
					throw new ControlError(409, "configuration revision conflict");
				if (
					latest.configuration.connections.some(
						(entry) =>
							entry.repositoryId === connection.repositoryId &&
							entry.accountId !== principal.accountId,
					)
				)
					throw new ControlError(409, "repository belongs to another account");
				if (
					latest.configuration.connections.some(
						(entry) =>
							entry.repository.toLowerCase() ===
								connection.repository.toLowerCase() &&
							entry.repositoryId !== connection.repositoryId,
					)
				)
					throw new ControlError(409, "repository identity changed");
				const existing = latest.configuration.connections.find(
					(entry) => entry.repositoryId === connection.repositoryId,
				);
				if (existing?.isolatedOnly) {
					if (
						existing.installationId !== connection.installationId ||
						(input.runnerGroupId !== 0 &&
							input.runnerGroupId !== existing.runnerGroupId) ||
						!existing.acceptAllMatchingRepositoryJobs
					)
						throw new ControlError(
							409,
							"existing connection requires operator migration",
						);
					// Identity and authority were checked live above. Revalidation must
					// preserve custom runner settings, active leases and the revision.
					return response(
						200,
						toJsonString(ConnectionSchema, existing),
						latest.revision,
					);
				}
				const next = create(ConfigurationSchema, {
					accounts: latest.configuration.accounts,
					connections: [
						...latest.configuration.connections.filter(
							(entry) => entry.repositoryId !== connection.repositoryId,
						),
						connection,
					],
				});
				const saved = await store.configure(next, expected, relay.now());
				return response(
					200,
					toJsonString(ConnectionSchema, connection),
					saved.revision,
				);
			}
			if (
				path === "/v1/accounts/self/repositories/prepare" &&
				request.method === "POST"
			) {
				const current = (await state()).configuration;
				if (
					!current?.accounts.some((entry) => entry.id === principal.accountId)
				)
					throw new ControlError(
						409,
						"create an account policy before connecting a repository",
					);
				const input = fromJsonString(
					RepositorySetupRequestSchema,
					await readBody(request),
				);
				if (
					!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
					!Number.isSafeInteger(input.repositoryId) ||
					input.repositoryId < 0 ||
					!Number.isSafeInteger(input.installationId) ||
					input.installationId < 0 ||
					!input.trustedRepositoryAcknowledged ||
					input.allowedRefs.some(
						(ref) => !ref.startsWith("refs/heads/") || ref.length > 200,
					)
				)
					throw new ControlError(
						400,
						"trusted repository identity and branch allowlist required",
					);
				if (!input.installationId) {
					if (
						principal.installationIds.length !== 1 ||
						!principal.installationIds[0]
					)
						throw new ControlError(400, "select a bound GitHub installation");
					input.installationId = principal.installationIds[0];
				}
				await scope(
					principal,
					input.repositoryId,
					input.repository,
					input.installationId,
				);
				// A plan produced here always installs the shared-host bridge. Do not
				// create an unusable plan on a deployment that denies that execution
				// path; isolated repositories use the separate isolated-connect route.
				if (relay.options.denyUnisolated)
					throw new ControlError(
						409,
						"workflow bridge is unavailable on this relay",
					);
				if (!input.repositoryId || input.allowedRefs.length === 0) {
					const lookup = await options.github.request(
						input.installationId,
						`/repos/${input.repository}`,
					);
					if (!lookup.ok)
						throw new ControlError(
							503,
							"GitHub repository discovery unavailable",
						);
					const found = z
						.object({
							id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
							full_name: z.string(),
							default_branch: z.string().min(1),
						})
						.parse(await lookup.json());
					if (
						found.full_name.toLowerCase() !== input.repository.toLowerCase() ||
						(input.repositoryId && input.repositoryId !== found.id)
					)
						throw new ControlError(409, "GitHub repository identity changed");
					input.repositoryId = found.id;
					if (!input.allowedRefs.length)
						input.allowedRefs = [`refs/heads/${found.default_branch}`];
					await scope(
						principal,
						input.repositoryId,
						input.repository,
						input.installationId,
					);
				}
				const plan = await prepareOnboarding(options.github, {
					principal,
					repository: input.repository,
					installationId: input.installationId,
					expectedRepositoryId: input.repositoryId,
					relayUrl: options.publicOrigin,
					trustedRefs: input.allowedRefs,
					trustedRepositoryAcknowledged: input.trustedRepositoryAcknowledged,
					publicRepoAcknowledged: input.publicRepositoryAcknowledged,
					allowAllPullRequests: input.allowAllPullRequests,
					isolatedHostAvailable: !!relay.options.isolatedHost,
					runnerGroupId: input.runnerGroupId || 1,
					assets: options.assets,
				});
				const op = create(OnboardingOperationSchema, {
					id: randomUUID(),
					plan,
					status: "planned",
				});
				return response(
					201,
					toJsonString(
						OnboardingOperationSchema,
						await record(op, principal.accountId),
					),
				);
			}
			const setup =
				/^\/v1\/accounts\/self\/repositories\/([a-f0-9-]{36})(?:\/(apply|connect))?$/.exec(
					path,
				);
			const lease =
				/^\/v1\/accounts\/self\/leases\/([a-f0-9-]{36})(?:\/(reconcile))?$/.exec(
					path,
				);
			if (setup?.[1]) {
				const op = await operation(setup[1], principal.accountId);
				if (request.method === "GET" && !setup[2])
					return response(200, toJsonString(OnboardingOperationSchema, op));
				if (request.method !== "POST" || !setup[2])
					throw new ControlError(405, "method not allowed");
				if ((await readBody(request)).trim())
					throw new ControlError(
						400,
						"setup actions use the stored reviewed plan",
					);
				if (!op.plan) throw new Error("setup plan missing");
				const plan = parseOnboardingPlan(
					toJsonString(OnboardingPlanSchema, op.plan),
				);
				if (plan.allowAllPullRequests && !relay.options.isolatedHost)
					throw new ControlError(
						409,
						"isolated runner required for pull requests",
					);
				await scope(
					principal,
					plan.repositoryId,
					plan.repository,
					plan.installationId,
				);
				// Plans may outlive a deployment or be prepared by another one. Do
				// not install files or store a connection if this relay cannot run it.
				if (relay.options.denyUnisolated)
					throw new ControlError(
						409,
						"workflow bridge is unavailable on this relay",
					);
				if (setup[2] === "apply") {
					if (op.status === "ready")
						return response(200, toJsonString(OnboardingOperationSchema, op));
					op.status = "applying";
					const started = await record(op, principal.accountId);
					if (started.status === "ready")
						return response(
							200,
							toJsonString(OnboardingOperationSchema, started),
						);
					try {
						op.result = await applyOnboarding(
							options.github,
							principal,
							plan,
							!!relay.options.isolatedHost,
						);
						op.status = "pending";
					} catch (error) {
						op.status = "uncertain";
						const saved = await record(op, principal.accountId);
						if (saved.status === "ready")
							return response(
								200,
								toJsonString(OnboardingOperationSchema, saved),
							);
						throw error;
					}
					const saved = await record(op, principal.accountId);
					return response(
						saved.status === "ready" ? 200 : 202,
						toJsonString(OnboardingOperationSchema, saved),
					);
				}
				const expected = revision(request);
				const before = await state();
				if (before.revision !== expected || !before.configuration)
					throw new ControlError(409, "configuration revision conflict");
				const linked = before.configuration.connections.find(
					(entry) => entry.repositoryId === plan.repositoryId,
				);
				const expectedEvents = plan.allowAllPullRequests
					? ["push", "workflow_dispatch", "pull_request"]
					: ["push", "workflow_dispatch"];
				const sameStrings = (
					actual: readonly string[],
					expected: readonly string[],
				) =>
					actual.length === expected.length &&
					new Set(actual).size === actual.length &&
					actual.every((value) => expected.includes(value));
				if (
					linked &&
					linked.accountId === principal.accountId &&
					linked.installationId === plan.installationId &&
					linked.repository.toLowerCase() === plan.repository.toLowerCase() &&
					linked.bridgeRef === plan.bridgeRef &&
					linked.bridgeWorkflow === plan.bridgeWorkflow &&
					linked.runnerGroupId === plan.runnerGroupId &&
					linked.dispatcherActorId === plan.dispatcherActorId &&
					linked.trustedRepositoryAcknowledged ===
						plan.trustedRepositoryAcknowledged &&
					linked.publicRepositoryAcknowledged === plan.publicRepoAcknowledged &&
					linked.allowAllPullRequests === plan.allowAllPullRequests &&
					sameStrings(linked.allowedEvents, expectedEvents) &&
					sameStrings(linked.allowedRefs, plan.trustedRefs)
				) {
					op.status = "ready";
					return response(
						200,
						toJsonString(
							OnboardingOperationSchema,
							await record(op, principal.accountId),
						),
						expected,
					);
				}
				if (
					linked &&
					(await store.all()).some(
						(entry) =>
							entry.repositoryId === plan.repositoryId &&
							[
								"reserved",
								"dispatching",
								"dispatched",
								"claiming",
								"running",
								"uncertain",
							].includes(entry.state),
					)
				)
					throw new ControlError(
						409,
						"drain active repository leases before changing its connection",
					);
				const connection = await connectRepository(
					options.github,
					principal,
					plan,
					!!relay.options.isolatedHost,
				);
				const latest = await state();
				if (latest.revision !== expected || !latest.configuration)
					throw new ControlError(409, "configuration revision conflict");
				if (
					latest.configuration.connections.some(
						(entry) =>
							entry.repositoryId === connection.repositoryId &&
							entry.accountId !== principal.accountId,
					)
				)
					throw new ControlError(409, "repository belongs to another account");
				const next = create(ConfigurationSchema, {
					accounts: latest.configuration.accounts,
					connections: [
						...latest.configuration.connections.filter(
							(entry) => entry.repositoryId !== connection.repositoryId,
						),
						connection,
					],
				});
				const saved = await store.configure(next, expected, relay.now());
				op.status = "ready";
				return response(
					200,
					toJsonString(
						OnboardingOperationSchema,
						await record(op, principal.accountId),
					),
					saved.revision,
				);
			}
			if (lease?.[1]) {
				const found = await store.get(lease[1]);
				if (!found || found.accountId !== principal.accountId)
					throw new ControlError(404, "lease not found");
				if (request.method === "GET" && !lease[2])
					return response(200, toJsonString(LeaseSchema, found));
				if (request.method === "POST" && lease[2] === "reconcile") {
					const input = fromJsonString(
						ReconcileRequestSchema,
						await readBody(request),
					);
					if (!Number.isSafeInteger(input.hostRunId) || input.hostRunId < 1)
						throw new ControlError(400, "positive host run id required");
					await relay.reconcile(found.id, input.hostRunId);
					return response(
						200,
						toJsonString(LeaseSchema, (await store.get(found.id)) ?? found),
					);
				}
				throw new ControlError(405, "method not allowed");
			}
			throw new ControlError(404, "account endpoint not found");
		} catch (error) {
			if (error instanceof IsolatedOnboardingError)
				return response(error.status, JSON.stringify({ error: error.message }));
			if (error instanceof ControlError)
				return response(error.status, JSON.stringify({ error: error.message }));
			if (error instanceof OnboardingPendingError)
				return response(
					409,
					'{"error":"repository setup pull request must be merged before connection"}',
				);
			if (
				error instanceof Error &&
				/revision conflict|active lease prevents|snapshot cannot move backwards|routing signal watermark|routing signal state|spending watermark|budget period|budget policy revision|retired budget/i.test(
					error.message,
				)
			)
				return response(
					409,
					'{"error":"configuration conflicts with current revision, active leases or usage evidence"}',
				);
			if (
				error instanceof SyntaxError ||
				(error instanceof Error &&
					/invalid|expected|cannot decode|unrecognized|cannot be decoded|unknown field|out of range/i.test(
						error.message,
					))
			)
				return response(400, '{"error":"invalid account request"}');
			return response(
				503,
				'{"error":"account operation could not be confirmed; retry or inspect its durable state"}',
			);
		}
	};
}
