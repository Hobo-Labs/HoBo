import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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
	type Configuration,
	ConfigurationSchema,
	type ControlCredential,
	ControlCredentialsSchema,
	ciBudgetPolicyJson,
	ciBudgetSignalUpdate,
	DesiredCiPolicySchema,
	effectiveCiAccount,
	LeaseSchema,
	parseCiPolicy,
	parseConfiguration,
	ReconcileRequestSchema,
	RepositorySetupRequestSchema,
	SnapshotSchema,
} from "@hobo/ci";
import { z } from "zod";
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
import type { Relay } from "./relay.js";

export type ControlPrincipal = Pick<
	ControlCredential,
	"accountId" | "installationIds" | "scopes"
>;
export type ControlAuthenticator = (
	authorization: string | undefined,
) => ControlPrincipal | undefined | Promise<ControlPrincipal | undefined>;
export function createControlAuthenticator(json: string): ControlAuthenticator {
	const credentials = fromJsonString(ControlCredentialsSchema, json);
	if (credentials.tokens.length < 1 || credentials.tokens.length > 1000)
		throw new Error("invalid control credential count");
	const hashes = new Set<string>();
	const installationOwners = new Map<number, string>();
	for (const credential of credentials.tokens) {
		if (
			!/^[a-zA-Z0-9_-]{1,80}$/.test(credential.accountId) ||
			!/^[a-f0-9]{64}$/.test(credential.tokenSha256) ||
			hashes.has(credential.tokenSha256) ||
			credential.installationIds.some(
				(id) => !Number.isSafeInteger(id) || id < 1,
			) ||
			credential.scopes.length === 0 ||
			credential.scopes.some(
				(scope) =>
					![
						"policy:read",
						"policy:write",
						"repositories:write",
						"operations:write",
						"observations:write",
					].includes(scope),
			)
		)
			throw new Error("invalid control credential binding");
		hashes.add(credential.tokenSha256);
		for (const id of credential.installationIds) {
			const owner = installationOwners.get(id);
			if (owner && owner !== credential.accountId)
				throw new Error("GitHub installation must have one account owner");
			installationOwners.set(id, credential.accountId);
		}
		Object.freeze(credential.installationIds);
		Object.freeze(credential.scopes);
		Object.freeze(credential);
	}
	return (authorization) => {
		if (
			!authorization?.startsWith("Bearer ") ||
			authorization.length < 39 ||
			authorization.length > 1031
		)
			return undefined;
		const digest = createHash("sha256").update(authorization.slice(7)).digest();
		let principal: ControlPrincipal | undefined;
		for (const credential of credentials.tokens)
			if (timingSafeEqual(digest, Buffer.from(credential.tokenSha256, "hex")))
				principal = credential;
		return principal;
	};
}
class ControlError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function body(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += value.length;
		if (bytes > 1024 * 1024)
			throw new ControlError(413, "request body too large");
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function revision(request: IncomingMessage): number {
	const value = z
		.string()
		.regex(/^(?:\d+|"\d+")$/)
		.safeParse(request.headers["if-match"]);
	if (!value.success)
		throw new ControlError(428, "If-Match configuration revision required");
	const parsed = Number(value.data.replaceAll('"', ""));
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new ControlError(400, "invalid configuration revision");
	return parsed;
}

/** Mount this authenticated account API beside the signed GitHub webhook handler. */
export function createControlPlane(options: {
	relay: Relay;
	github: OnboardingGithubPort;
	authenticate: ControlAuthenticator;
	publicOrigin: string;
	assets: { workflow: string; bootstrap: string };
	onChange?: () => void;
}) {
	const { relay } = options;
	const store = relay.options.store;
	function configuration(): Configuration {
		const current = store.configuration()?.configuration;
		if (!current) throw new ControlError(503, "configuration is unavailable");
		return current;
	}
	function save(next: Configuration, expectedRevision: number) {
		const state = store.configure(next, expectedRevision, relay.now());
		if (!state.configuration) throw new Error("configuration commit missing");
		relay.options.config = state.configuration;
		try {
			options.onChange?.();
		} catch {
			/* A committed policy remains committed if notification fails. */
		}
		return state;
	}
	function operation(id: string, accountId: string): OnboardingOperation {
		const record = store.controlRecord(`onboarding:${id}`);
		if (!record || record.accountId !== accountId)
			throw new ControlError(404, "setup operation not found");
		return fromJsonString(OnboardingOperationSchema, record.bodyJson);
	}
	function record(operation: OnboardingOperation, accountId: string) {
		const existing = store.controlRecord(`onboarding:${operation.id}`);
		if (existing?.accountId === accountId) {
			const current = fromJsonString(
				OnboardingOperationSchema,
				existing.bodyJson,
			);
			if (current.status === "ready" && operation.status !== "ready")
				return current;
		}
		store.putControlRecord(
			`onboarding:${operation.id}`,
			accountId,
			toJsonString(OnboardingOperationSchema, operation),
			relay.now(),
		);
		return operation;
	}
	function repositoryScope(
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
		if (
			configuration().connections.some(
				(entry) =>
					(entry.repositoryId === repositoryId ||
						entry.repository.toLowerCase() === repository.toLowerCase()) &&
					entry.accountId !== principal.accountId,
			)
		)
			throw new ControlError(409, "repository belongs to another account");
	}
	function send(
		response: ServerResponse,
		status: number,
		value: string,
		etag?: number,
	) {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Cache-Control", "no-store");
		if (etag !== undefined) response.setHeader("ETag", `"${etag}"`);
		response.writeHead(status).end(value);
	}
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<boolean> => {
		const path = request.url?.split("?")[0] ?? "";
		if (
			!path.startsWith("/v1/accounts/self/") &&
			!path.startsWith("/v2/accounts/self/")
		)
			return false;
		try {
			const principal = await options.authenticate(
				request.headers.authorization,
			);
			if (!principal)
				throw new ControlError(401, "account authentication required");
			const scope =
				path === "/v2/accounts/self/signals"
					? "observations:write"
					: request.method === "GET"
						? "policy:read"
						: path.includes("/repositories/")
							? "repositories:write"
							: path.includes("/leases/")
								? "operations:write"
								: "policy:write";
			if (!principal.scopes.includes(scope))
				throw new ControlError(403, "account scope required");
			const current = configuration();
			if (
				path === "/v2/accounts/self/signals" &&
				["GET", "POST"].includes(request.method ?? "")
			) {
				const signal =
					request.method === "POST"
						? fromJsonString(BudgetSignalSchema, await body(request))
						: undefined;
				const expected = signal ? revision(request) : undefined;
				const state = store.configuration();
				if (
					!state?.configuration ||
					(expected !== undefined && state.revision !== expected)
				)
					throw new ControlError(409, "configuration revision conflict");
				const config = clone(ConfigurationSchema, state.configuration);
				const account = config.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				if (!account) throw new ControlError(404, "account not found");
				let saved = state;
				if (signal) {
					const record = store.controlRecord(
						`ci-policy:${principal.accountId}`,
					);
					if (!record || record.accountId !== principal.accountId)
						throw new ControlError(
							409,
							"desired policy is required before budget signals",
						);
					const policy = parseCiPolicy(record.bodyJson);
					if (
						ciBudgetPolicyJson(account.budgetPolicy) !==
						ciBudgetPolicyJson(policy.budgetPolicy)
					)
						throw new ControlError(
							409,
							"desired and active budget scope differ",
						);
					let update: ReturnType<typeof ciBudgetSignalUpdate>;
					try {
						update = ciBudgetSignalUpdate(signal, policy);
					} catch {
						throw new ControlError(400, "invalid or foreign budget signal");
					}
					if (
						update.watermark > (account.routingSignalCycles[update.key] ?? 0)
					) {
						account.routingSignalCycles[update.key] = update.watermark;
						account.routingSignalCrossed[update.key] = update.crossed;
						saved = save(config, state.revision);
					}
				}
				send(
					response,
					200,
					toJsonString(
						AccountStateSchema,
						create(AccountStateSchema, {
							revision: saved.revision,
							account,
							connections: config.connections.filter(
								(entry) => entry.accountId === principal.accountId,
							),
							updatedAt: saved.updatedAt,
						}),
					),
					saved.revision,
				);
			} else if (
				path === "/v2/accounts/self/policy" &&
				request.method === "PUT"
			) {
				const expected = revision(request);
				const input = await body(request);
				let desired: ReturnType<typeof parseCiPolicy>;
				try {
					desired = parseCiPolicy(input);
				} catch {
					throw new ControlError(400, "invalid desired CI policy");
				}
				if (desired.accountId !== principal.accountId)
					throw new ControlError(
						403,
						"account policy belongs to another account",
					);
				const state = store.configuration();
				if (!state?.configuration || state.revision !== expected)
					throw new ControlError(409, "configuration revision conflict");
				const config = clone(ConfigurationSchema, state.configuration);
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
					if (offer.backend === "sandbox")
						throw new ControlError(
							409,
							"sandbox providers are unavailable on this relay",
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
				const saved = store.configureWithRecord(
					config,
					expected,
					relay.now(),
					`ci-policy:${principal.accountId}`,
					principal.accountId,
					toJsonString(DesiredCiPolicySchema, desired),
				);
				if (!saved.configuration)
					throw new Error("configuration commit missing");
				relay.options.config = saved.configuration;
				try {
					options.onChange?.();
				} catch {
					/* A committed policy remains committed if notification fails. */
				}
				send(
					response,
					200,
					toJsonString(
						AccountStateSchema,
						create(AccountStateSchema, {
							revision: saved.revision,
							account,
							connections: config.connections.filter(
								(entry) => entry.accountId === principal.accountId,
							),
							updatedAt: saved.updatedAt,
						}),
					),
					saved.revision,
				);
			} else if (
				path === "/v1/accounts/self/installations" &&
				request.method === "GET"
			) {
				send(
					response,
					200,
					toJsonString(
						OnboardingPrincipalSchema,
						create(OnboardingPrincipalSchema, {
							accountId: principal.accountId,
							installationIds: principal.installationIds,
						}),
					),
				);
			} else if (
				path === "/v1/accounts/self/policy" &&
				request.method === "GET"
			) {
				const account = current.accounts.find(
					(entry) => entry.id === principal.accountId,
				);
				const state = store.configuration();
				const accountState = create(AccountStateSchema, {
					revision: state?.revision ?? 0,
					connections: current.connections.filter(
						(entry) => entry.accountId === principal.accountId,
					),
					updatedAt: state?.updatedAt ?? "",
				});
				if (account) accountState.account = account;
				send(
					response,
					200,
					toJsonString(AccountStateSchema, accountState),
					state?.revision,
				);
			} else if (
				path === "/v1/accounts/self/policy" &&
				request.method === "PUT"
			) {
				const expected = revision(request);
				const account = fromJsonString(AccountSchema, await body(request));
				if (account.id !== principal.accountId)
					throw new ControlError(
						403,
						"account policy belongs to another account",
					);
				if (
					store.controlRecord(`ci-policy:${principal.accountId}`) ||
					configuration().accounts.find(
						(entry) => entry.id === principal.accountId,
					)?.budgetPolicy
				)
					throw new ControlError(410, "use v2 desired policy for this account");
				const latest = configuration();
				const next = create(ConfigurationSchema, {
					accounts: [
						...latest.accounts.filter(
							(entry) => entry.id !== principal.accountId,
						),
						account,
					],
					connections: latest.connections,
				});
				try {
					parseConfiguration(toJsonString(ConfigurationSchema, next));
				} catch {
					throw new ControlError(400, "invalid account policy");
				}
				const state = save(next, expected);
				send(
					response,
					200,
					toJsonString(
						AccountStateSchema,
						create(AccountStateSchema, {
							revision: state.revision,
							account,
							connections: next.connections.filter(
								(entry) => entry.accountId === principal.accountId,
							),
							updatedAt: state.updatedAt,
						}),
					),
					state.revision,
				);
			} else if (
				path === "/v1/accounts/self/leases" &&
				request.method === "GET"
			) {
				send(
					response,
					200,
					toJsonString(
						SnapshotSchema,
						create(SnapshotSchema, {
							leases: store
								.all()
								.filter((lease) => lease.accountId === principal.accountId)
								.slice(-100),
							events: store
								.events()
								.filter((event) => event.accountId === principal.accountId)
								.slice(-100),
						}),
					),
				);
			} else if (
				path === "/v1/accounts/self/repositories/prepare" &&
				request.method === "POST"
			) {
				if (
					!current.accounts.some(
						(account) => account.id === principal.accountId,
					)
				)
					throw new ControlError(
						409,
						"create an account policy before connecting a repository",
					);
				const input = fromJsonString(
					RepositorySetupRequestSchema,
					await body(request),
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
				if (input.installationId === 0) {
					if (
						principal.installationIds.length !== 1 ||
						!principal.installationIds[0]
					)
						throw new ControlError(400, "select a bound GitHub installation");
					input.installationId = principal.installationIds[0];
				}
				repositoryScope(
					principal,
					input.repositoryId,
					input.repository,
					input.installationId,
				);
				if (input.repositoryId === 0 || input.allowedRefs.length === 0) {
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
						(input.repositoryId !== 0 && input.repositoryId !== found.id)
					)
						throw new ControlError(409, "GitHub repository identity changed");
					input.repositoryId = found.id;
					if (input.allowedRefs.length === 0)
						input.allowedRefs = [`refs/heads/${found.default_branch}`];
					repositoryScope(
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
					runnerGroupId: input.runnerGroupId || 1,
					assets: options.assets,
				});
				const result = create(OnboardingOperationSchema, {
					id: randomUUID(),
					plan,
					status: "planned",
				});
				record(result, principal.accountId);
				send(response, 201, toJsonString(OnboardingOperationSchema, result));
			} else {
				const setup =
					/^\/v1\/accounts\/self\/repositories\/([a-f0-9-]{36})(?:\/(apply|connect))?$/.exec(
						path,
					);
				const lease =
					/^\/v1\/accounts\/self\/leases\/([a-f0-9-]{36})(?:\/(reconcile))?$/.exec(
						path,
					);
				if (setup?.[1]) {
					const op = operation(setup[1], principal.accountId);
					if (request.method === "GET" && !setup[2])
						send(response, 200, toJsonString(OnboardingOperationSchema, op));
					else if (
						request.method === "POST" &&
						(setup[2] === "apply" || setup[2] === "connect")
					) {
						if ((await body(request)).trim())
							throw new ControlError(
								400,
								"setup actions use the stored reviewed plan, not request JSON",
							);
						if (!op.plan) throw new Error("setup plan missing");
						const plan = parseOnboardingPlan(
							toJsonString(OnboardingPlanSchema, op.plan),
						);
						if (plan.allowAllPullRequests)
							throw new ControlError(
								409,
								"isolated runner required for pull requests",
							);
						repositoryScope(
							principal,
							plan.repositoryId,
							plan.repository,
							plan.installationId,
						);
						if (setup[2] === "apply") {
							if (op.status === "ready") {
								send(
									response,
									200,
									toJsonString(OnboardingOperationSchema, op),
								);
								return true;
							}
							op.status = "applying";
							record(op, principal.accountId);
							try {
								op.result = await applyOnboarding(
									options.github,
									principal,
									plan,
								);
								op.status = "pending";
							} catch (error) {
								op.status = "uncertain";
								const current = record(op, principal.accountId);
								if (current.status === "ready") {
									send(
										response,
										200,
										toJsonString(OnboardingOperationSchema, current),
									);
									return true;
								}
								throw error;
							}
							const committed = record(op, principal.accountId);
							send(
								response,
								committed.status === "ready" ? 200 : 202,
								toJsonString(OnboardingOperationSchema, committed),
							);
						} else {
							const expected = revision(request);
							if (store.configuration()?.revision !== expected)
								throw new ControlError(409, "configuration revision conflict");
							const linked = configuration().connections.find(
								(entry) => entry.repositoryId === plan.repositoryId,
							);
							if (
								linked &&
								linked.accountId === principal.accountId &&
								linked.installationId === plan.installationId &&
								linked.bridgeRef === plan.bridgeRef &&
								linked.bridgeWorkflow === plan.bridgeWorkflow &&
								linked.runnerGroupId === plan.runnerGroupId &&
								linked.dispatcherActorId === plan.dispatcherActorId
							) {
								// Recover a crash after the verified connection commit but before
								// its operation acknowledgment, without modifying an active pin.
								op.status = "ready";
								record(op, principal.accountId);
								send(
									response,
									200,
									toJsonString(OnboardingOperationSchema, op),
									expected,
								);
								return true;
							}
							if (
								op.status !== "ready" &&
								configuration().connections.some(
									(entry) => entry.repositoryId === plan.repositoryId,
								) &&
								store
									.all()
									.some(
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
									"drain active repository leases before changing its bridge pin",
								);
							const connection = await connectRepository(
								options.github,
								principal,
								plan,
							);
							const latest = configuration();
							if (
								latest.connections.some(
									(entry) =>
										entry.repositoryId === connection.repositoryId &&
										entry.accountId !== principal.accountId,
								)
							)
								throw new ControlError(
									409,
									"repository belongs to another account",
								);
							const next = create(ConfigurationSchema, {
								accounts: latest.accounts,
								connections: [
									...latest.connections.filter(
										(entry) => entry.repositoryId !== connection.repositoryId,
									),
									connection,
								],
							});
							const saved = save(next, expected);
							op.status = "ready";
							record(op, principal.accountId);
							send(
								response,
								200,
								toJsonString(OnboardingOperationSchema, op),
								saved.revision,
							);
						}
					} else throw new ControlError(405, "method not allowed");
				} else if (lease?.[1]) {
					const found = store.get(lease[1]);
					if (!found || found.accountId !== principal.accountId)
						throw new ControlError(404, "lease not found");
					if (request.method === "POST" && lease[2] === "reconcile") {
						const input = fromJsonString(
							ReconcileRequestSchema,
							await body(request),
						);
						if (!Number.isSafeInteger(input.hostRunId) || input.hostRunId < 1)
							throw new ControlError(400, "positive host run id required");
						await relay.reconcile(found.id, input.hostRunId);
						send(
							response,
							200,
							toJsonString(LeaseSchema, store.get(found.id) ?? found),
						);
					} else if (request.method === "GET" && !lease[2])
						send(response, 200, toJsonString(LeaseSchema, found));
					else throw new ControlError(405, "method not allowed");
				} else throw new ControlError(404, "account endpoint not found");
			}
		} catch (error) {
			if (error instanceof ControlError)
				send(response, error.status, JSON.stringify({ error: error.message }));
			else if (error instanceof OnboardingPendingError)
				send(
					response,
					409,
					'{"error":"repository setup pull request must be merged before connection"}',
				);
			else if (
				error instanceof Error &&
				/revision conflict|active lease prevents|snapshot cannot move backwards|routing signal watermark|routing signal state|spending watermark|budget period|budget policy revision|retired budget/.test(
					error.message,
				)
			)
				send(
					response,
					409,
					'{"error":"configuration conflicts with current revision, active leases or usage evidence"}',
				);
			else if (
				error instanceof SyntaxError ||
				(error instanceof Error &&
					/invalid|expected|cannot decode|unrecognized|cannot be decoded|unknown field|out of range/i.test(
						error.message,
					))
			)
				send(response, 400, '{"error":"invalid account request"}');
			else
				send(
					response,
					503,
					'{"error":"account operation could not be confirmed; retry or inspect its durable state"}',
				);
		}
		return true;
	};
}
