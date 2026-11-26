import type { ClaimBundle } from "@hobo/claims";
import type { CommandModule, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT, deploymentIdFor } from "@hobo/cli";
import {
	currentFenceToken,
	deploymentClaimed,
	deploymentViewProjection,
} from "@hobo/cloud";
import type { PrincipalRef } from "@hobo/core";
import { markAuthMdInfrastructureClaim } from "./auth-md-command.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import {
	type BrokerDiscoveryClient,
	createBrokerDiscoveryClient,
} from "./broker-discovery.js";
import {
	createMockRemoteBrokerState,
	createRemoteBrokerClient,
	type MockRemoteBrokerState,
	type RemoteBrokerClient,
	RemoteBrokerClientError,
} from "./broker-remote-client.js";
import { resolveBrokerUriFromFlags } from "./broker-target.js";
import type { ClaimOwnershipVerifier } from "./claim-ceremony.js";
import { runClaimCeremony } from "./claim-ceremony.js";
import {
	type CredentialPresenter,
	createCredentialPresenter,
} from "./credential-presenter.js";
import { isJsonString } from "./json.js";

export interface ClaimCommandDeps {
	// The shared Yard runtime whose durable log carries the deployment. The
	// composed CLI injects the same runtime `up` writes to.
	readonly fetchImpl?: typeof fetch;
	readonly runtime?: YardRuntime;
	readonly discovery?: BrokerDiscoveryClient;
	readonly presenter?: CredentialPresenter;
	readonly createRemoteClient?: (brokerUri: string) => RemoteBrokerClient;
	readonly mockRemote?: MockRemoteBrokerState;
	readonly env?: NodeJS.ProcessEnv;
	readonly bundle?: ClaimBundle;
	readonly verifyOwnership?: ClaimOwnershipVerifier;
}

// `hobo claim` — bind an anonymous deployment to an account WITHOUT
// re-provisioning. Local: appends `deployment.Claimed` on the event store.
// Remote: exchanges claim token with target broker; preserves resources/URL.
//
// Optional human WebAuthn/passkey step-up is human-only (agents never hold
// passkeys). HONEST SCOPE: WebAuthn ceremony is not enforced in this slice;
// remote claim verifies token validity/expiry via the broker client.
export function createClaimCommand(deps: ClaimCommandDeps = {}): CommandModule {
	const presenter = deps.presenter ?? createCredentialPresenter();

	return {
		run: async ({ context, flags, args }) => {
			const env =
				// SAFETY: assertion required at this I/O or test boundary.
				deps.env ?? (context as { env?: NodeJS.ProcessEnv }).env ?? process.env;

			// The multi-step ownership ceremony (ADR-0151): a bundle can hold two
			// providers with two clocks, so it gets verbs of its own rather than
			// being collapsed into the single-shot account rebind below.
			const subcommand = args[0];
			if (
				subcommand === "status" ||
				subcommand === "open" ||
				subcommand === "finalize"
			) {
				return runClaimCeremony({
					subcommand,
					args: args.slice(1),
					flags,
					context,
					deps,
				});
			}

			const accountRaw = args[0] ?? flags.to;
			const account =
				isJsonString(accountRaw) && accountRaw.length > 0 ? accountRaw : null;
			if (!account) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_CLAIM_NO_ACCOUNT",
					message:
						"hobo claim needs an account: `hobo claim <account>` (or `--to <account>`).",
					remediation: ["Pass the account to bind to, e.g. `hobo claim acme`."],
					data: { command: "claim" },
				};
			}

			const brokerUri = resolveBrokerUriFromFlags({
				broker: flags.broker,
				brokerUri: flags.brokerUri,
			});
			const token =
				isJsonString(flags.token) && flags.token.length > 0
					? flags.token
					: null;

			// Remote claim path
			if (brokerUri !== null || token !== null) {
				if (brokerUri === null) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CLAIM_NO_BROKER",
						message:
							"hobo claim: remote claim requires --broker <uri> with --token <claimToken>.",
						remediation: [
							"Example: `hobo claim acme --broker https://public.example.com --token <claimToken>`.",
							"Or omit both for local event-store claim after `hobo up`.",
						],
						data: { command: "claim" },
					};
				}
				if (token === null) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CLAIM_NO_TOKEN",
						message:
							"hobo claim: remote claim requires --token <claimToken> (from anonymous `hobo up`).",
						remediation: [
							"Copy claimToken from anonymous `hobo up --broker ... --anonymous` output.",
							`Example: \`hobo claim ${account} --broker ${brokerUri} --token <claimToken>\`.`,
						],
						data: { command: "claim", brokerUri },
					};
				}

				const hoboHome =
					isJsonString(flags.home) && flags.home.length > 0
						? flags.home
						: defaultHoboHome(env);

				try {
					const client =
						deps.createRemoteClient?.(brokerUri) ??
						createRemoteBrokerClient({
							brokerUri,
							...(deps.fetchImpl === undefined
								? undefined
								: { fetchImpl: deps.fetchImpl }),
							...(deps.discovery ? { discovery: deps.discovery } : undefined),
							...(deps.mockRemote ? { mock: deps.mockRemote } : undefined),
						});

					// Optional human credential for step-up metadata (never required for token claim).
					const credential = await presenter.presentAuthenticated({
						audience: brokerUri,
						hoboHome,
						env,
						requirePrincipal: false,
					});

					// HONEST SCOPE: WebAuthn/passkey step-up for high-privilege claim is
					// human-only and not enforced here; agents never hold passkeys.
					const result = await client.claim({
						claimToken: token,
						account,
						...(credential !== null ? { credential } : undefined),
					});

					await markAuthMdInfrastructureClaim(
						hoboHome,
						brokerUri,
						result.deploymentId,
					);

					return {
						ok: true,
						status: result.alreadyClaimed ? "already_claimed" : "claimed",
						code: "HOBO_OK",
						message: result.alreadyClaimed
							? `hobo claim: deployment "${result.deploymentId}" is already bound to ${account}.`
							: `hobo claim: bound remote "${result.deploymentId}" to ${account} (${Object.keys(result.resources).length} resource(s) preserved at ${result.primaryUrl}).`,
						data: {
							command: "claim",
							mode: "remote",
							brokerUri,
							deploymentId: result.deploymentId,
							previousOwner: result.previousOwner,
							owner: result.owner,
							deploymentStatus: result.status,
							resources: result.resources,
							primaryUrl: result.primaryUrl,
							// URL preserved — no re-provision.
							urlPreserved: true,
						},
					};
				} catch (error) {
					if (error instanceof RemoteBrokerClientError) {
						return {
							ok: false,
							status: "remote_claim_failed",
							code: error.code,
							message: `hobo claim: ${error.message}`,
							remediation: [
								"Ensure the claim token is from a recent anonymous `hobo up` and has not expired.",
								"Request a new temporary deploy if the TTL elapsed.",
								"Local claim: run without --broker/--token against a local deployment.",
							],
							data: {
								command: "claim",
								mode: "remote",
								brokerUri,
								...error.data,
							},
						};
					}
					throw error;
				}
			}

			// Local path
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo claim has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "claim" },
				};
			}

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);
			const stream = `deployment:${deploymentId}`;
			const snapshot = await deploymentViewProjection.rebuildFromZero(
				runtime.store,
				stream,
			);
			const row = deploymentViewProjection.get(snapshot, deploymentId);

			if (!row) {
				return {
					ok: false,
					status: "no_deployment",
					code: "HOBO_CLAIM_NO_DEPLOYMENT",
					message: `hobo claim: no deployment found for "${deploymentId}" — run \`hobo up\` first.`,
					data: { command: "claim", deploymentId },
				};
			}

			const previousOwner = row.owner;
			const newOwner: PrincipalRef = { kind: "user", id: account };

			// Already owned by this account — idempotent no-op.
			if (
				previousOwner?.kind === newOwner.kind &&
				previousOwner?.id === account
			) {
				return {
					ok: true,
					status: "already_claimed",
					code: "HOBO_OK",
					message: `hobo claim: deployment "${deploymentId}" is already bound to ${account}.`,
					data: {
						command: "claim",
						mode: "local",
						deploymentId,
						owner: newOwner,
					},
				};
			}

			// Continue the fenced deployment stream with the current owner
			// epoch rather than bypassing the fence (same rule as drift).
			const fenceToken = currentFenceToken(runtime.store, stream);
			await runtime.store.append(
				stream,
				[
					deploymentClaimed({
						deploymentId,
						...(previousOwner !== undefined ? { previousOwner } : undefined),
						newOwner,
					}),
				],
				{
					expectedSeq: snapshot.seq,
					actor: newOwner,
					tenant: DEFAULT_TENANT,
					...(fenceToken !== undefined ? { fenceToken } : undefined),
				},
			);

			// Re-fold to confirm the rebind preserved all provisioned state.
			const after = deploymentViewProjection.get(
				await deploymentViewProjection.rebuildFromZero(runtime.store, stream),
				deploymentId,
			);

			return {
				ok: true,
				status: "claimed",
				code: "HOBO_OK",
				message: `hobo claim: bound "${deploymentId}" to ${account} (${Object.keys(row.resources).length} resource(s) preserved).`,
				data: {
					command: "claim",
					mode: "local",
					deploymentId,
					previousOwner: previousOwner ?? null,
					owner: newOwner,
					// State is carried forward untouched by the rebind.
					deploymentStatus: after?.status ?? row.status,
					resources: after?.resources ?? row.resources,
				},
			};
		},
	};
}

/** Test helper: claim command wired to a shared mock remote broker. */
export function createClaimCommandWithMock(options?: {
	readonly runtime?: YardRuntime;
	readonly mock?: MockRemoteBrokerState;
	readonly brokerUri?: string;
}) {
	const mock =
		options?.mock ??
		createMockRemoteBrokerState({
			brokerUri: options?.brokerUri ?? "https://public.example.com",
		});
	const discovery = createBrokerDiscoveryClient({
		fixed: new Map([
			[mock.discovery.issuer.replace(/\/+$/, ""), mock.discovery],
		]),
	});
	return {
		mock,
		command: createClaimCommand({
			...(options?.runtime !== undefined
				? { runtime: options.runtime }
				: undefined),
			mockRemote: mock,
			discovery,
		}),
	};
}
