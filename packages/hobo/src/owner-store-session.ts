import { realpathSync } from "node:fs";
import path from "node:path";

import type { CredentialResolver } from "@hobo/cd";
import { createGithubAppTransport } from "@hobo/ci-gh-actions";
import {
	createTrustedVault,
	GITHUB_APP_CREDENTIAL_SCHEME,
	type GithubAppRepository,
	parseGithubAppInstallationRef,
	type TrustedVault,
} from "@hobo/core";
import {
	KEPT_STORE_SIGN_INS,
	type OpenedSecretStore,
	type OwnerChannel,
	type OwnerSignInOutcome,
	type OwnerStoreDeps,
	ownerStore,
	signInOwnerStore,
	storeLabel,
	withoutSecretEnv,
} from "@hobo/hobo-ci";
import { z } from "zod";

import {
	type AgentVaultBroker,
	type AgentVaultProxyDeps,
	type AgentVaultRouter,
	type AgentVaultStatus,
	createAgentVaultBroker,
} from "./agent-vault-broker.js";

export type OwnerStoreLabel = "Infisical" | "1Password" | "Bitwarden";

export type OwnerSessionState =
	| Readonly<{ status: "established"; store: OwnerStoreLabel }>
	| Readonly<{ status: "unchosen" }>
	| Readonly<{
			status: "sign-in-needed";
			store: OwnerStoreLabel;
			code: string;
			reason?: string;
	  }>;

export type OwnerSessionStatus = Readonly<{
	established: boolean;
	store?: OwnerStoreLabel;
	agentVault?: AgentVaultStatus;
	relaySession?: Readonly<{ expiresInSeconds: number }>;
}>;

export interface OwnerStoreEntries {
	read(name: string): Promise<string | undefined>;
	write(name: string, value: string): Promise<void>;
}

const LINK = /\bhttps?:\/\/\S+/gu;
const IDENTIFIER =
	/\b(?:(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}|[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){2,})\b/gu;

export function publicReason(message: string): string {
	return message
		.replace(LINK, "<link>")
		.replace(IDENTIFIER, "<id>")
		.slice(0, 300);
}

export type OwnerPageSignIn = Readonly<
	Partial<
		Record<
			| "INFISICAL_CLI_SESSION"
			| "INFISICAL_TOKEN"
			| "OP_CONNECT_TOKEN"
			| "BW_CLIENTID"
			| "BW_CLIENTSECRET",
			string
		>
	>
>;

export interface OwnerStoreSessions {
	establish(
		cwd: string,
		signIn?: OwnerPageSignIn,
		family?: "ci" | "cd",
	): Promise<OwnerSessionState>;
	invalidate?(cwd: string): void;
	status(cwd: string): OwnerSessionStatus;
	credentials(cwd: string): CredentialResolver;
	entries(cwd: string): OwnerStoreEntries;
	agentVault(cwd: string): AgentVaultRouter | undefined;
	close(): Promise<void>;
}

export class OwnerCredentialUnavailable extends Error {
	constructor(
		readonly ref: string,
		readonly reason:
			| "no-session"
			| "not-in-store"
			| "environment-ref"
			| "unsupported-ref"
			| "github-app-missing"
			| "github-app-not-installed"
			| "github-app-refused"
			| "relay-session-expired"
			| "relay-not-resolvable"
			| "relay-unreachable"
			| "relay-sign-in-failed",
	) {
		super(OwnerCredentialUnavailable.explain(ref, reason));
		this.name = "OwnerCredentialUnavailable";
	}

	private static explain(
		ref: string,
		reason: OwnerCredentialUnavailable["reason"],
	): string {
		switch (reason) {
			case "no-session":
				return `credential ${ref} needs the owner's store session: run HoBo MCP's choose_secret_store first, or sign in to an already configured HoBo CI relay with hobo login --relay <origin> (HoBo MCP: relay_login)`;
			case "not-in-store":
				return `credential ${ref} is not in the owner's store`;
			case "environment-ref":
				return `credential ${ref} names the process environment, which never holds credentials: store the entry in the owner's store, connect it with HoBo MCP's choose_secret_store, and use owner://<NAME>`;
			case "github-app-missing":
				return `credential ${ref} needs HoBo's GitHub App credentials (${GITHUB_APP_ID_ENTRY}, ${GITHUB_APP_PRIVATE_KEY_ENTRY}) in the owner's store relay folder: run hobo ci app create`;
			case "github-app-not-installed":
				return `credential ${ref} needs HoBo's GitHub App installed on that repository: install the App hobo ci app create made`;
			case "github-app-refused":
				return `credential ${ref} could not be minted: GitHub refused HoBo's GitHub App (check the App made by hobo ci app create)`;
			case "relay-session-expired":
				return `credential ${ref} needs a HoBo CI relay session: it ended with its process or expired, so sign in again with hobo login --relay <origin> or HoBo MCP's relay_login`;
			case "relay-not-resolvable":
				return `credential ${ref} is not one the HoBo CI relay resolves: it hands out only short-lived values (GitHub App installation tokens and the CI account credential); connect the owner's store with HoBo MCP's choose_secret_store for this entry`;
			case "relay-sign-in-failed":
				return `credential ${ref} needs a HoBo CI relay session, and the relay sign-in did not complete: run the command again and confirm the code at GitHub`;
			case "relay-unreachable":
				return `credential ${ref} could not be resolved: the HoBo CI relay did not answer`;
			case "unsupported-ref":
				return `credential ${ref} is not resolvable on this host (use owner://<NAME> or ${GITHUB_APP_CREDENTIAL_SCHEME}<owner>/<repo> after HoBo MCP's choose_secret_store)`;
		}
	}
}

// public-contract: the owner-store entry hobo ci app create writes with HoBo's GitHub App id.
export const GITHUB_APP_ID_ENTRY = "HOBO_CI_GITHUB_APP_ID";
// public-contract: the owner-store entry hobo ci app create writes with HoBo's GitHub App private key.
export const GITHUB_APP_PRIVATE_KEY_ENTRY = "HOBO_CI_GITHUB_APP_PRIVATE_KEY";

const RepositoryInstallation = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

// public-contract: the credential locator scheme that reads an entry from the owner's store session.
export const OWNER_CREDENTIAL_SCHEME = "owner://";

const ENTRY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;

function labelOf(id: string): OwnerStoreLabel {
	const label = storeLabel(id);
	return label === "1Password" || label === "Bitwarden" ? label : "Infisical";
}

const ENVIRONMENT_SCHEME = "env://";

function entryOf(ref: string): string {
	if (ref.startsWith(ENVIRONMENT_SCHEME))
		throw new OwnerCredentialUnavailable(ref, "environment-ref");
	const name = ref.startsWith(OWNER_CREDENTIAL_SCHEME)
		? ref.slice(OWNER_CREDENTIAL_SCHEME.length)
		: "";
	if (!ENTRY_NAME.test(name))
		throw new OwnerCredentialUnavailable(ref, "unsupported-ref");
	return name;
}

type Held = Readonly<{
	store: OpenedSecretStore;
	vault: TrustedVault;
	label: OwnerStoreLabel;
	broker: AgentVaultBroker | undefined;
}>;

export type OwnerSignIn = (input: {
	readonly cwd: string;
	readonly vault: TrustedVault;
	readonly family?: "ci" | "cd";
	readonly infisicalSession?: string;
}) => Promise<OwnerSignInOutcome>;

export function ownerWithPageSession(
	owner: OwnerChannel,
	session: string | undefined,
): OwnerChannel {
	let copiedSession = session;
	return {
		...owner,
		async openUrl(url, message, name) {
			if (name === "INFISICAL_CLI_SESSION" && copiedSession !== undefined)
				return;
			return owner.openUrl(url, message, name);
		},
		async captureSecret(request) {
			if (
				request.name === "INFISICAL_CLI_SESSION" &&
				copiedSession !== undefined
			) {
				const value = copiedSession;
				copiedSession = undefined;
				return value;
			}
			return owner.captureSecret(request);
		},
	};
}

export function ownerChannelSignIn(options: {
	readonly owner: OwnerChannel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly deps?: Omit<OwnerStoreDeps, "env" | "cwd" | "ownerChannel">;
}): OwnerSignIn {
	return async ({ cwd, vault, infisicalSession }) => {
		const plainEnv = withoutSecretEnv(options.env ?? process.env);
		const owner = ownerWithPageSession(options.owner, infisicalSession);
		const deps: OwnerStoreDeps = {
			...options.deps,
			env: plainEnv,
			cwd,
			ownerChannel: owner,
			noBrowser: true,
		};
		return signInOwnerStore({
			family: "cd",
			vault,
			open: (resolved) =>
				ownerStore("cd", vault, {
					...deps,
					env: { ...plainEnv, ...resolved },
				}),
			deps,
			plainEnv,
			workloadOidc: undefined,
			whatIf: false,
			handOff: true,
			silent: true,
			emit: () => undefined,
		});
	};
}

export type OwnerRelayFolder = (input: {
	readonly cwd: string;
	readonly vault: TrustedVault;
}) => Promise<OpenedSecretStore | undefined>;

export function ownerChannelRelayFolder(options: {
	readonly owner: OwnerChannel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly deps?: Omit<OwnerStoreDeps, "env" | "cwd" | "ownerChannel">;
}): OwnerRelayFolder {
	return async ({ cwd, vault }) => {
		const relay = await ownerStore("ci", vault, {
			...options.deps,
			env: withoutSecretEnv(options.env ?? process.env),
			cwd,
			ownerChannel: options.owner,
			noBrowser: true,
		});
		return relay.opened;
	};
}

async function readMaterial(
	port: OpenedSecretStore["port"],
	name: string,
): Promise<string | undefined> {
	const read = await port.access(name).catch(() => undefined);
	return read?.status === "ok" &&
		read.material !== undefined &&
		read.material !== ""
		? read.material
		: undefined;
}

async function mintInstallationToken(input: {
	readonly ref: string;
	readonly repository: GithubAppRepository;
	readonly relay: OpenedSecretStore | undefined;
	readonly fetch: typeof fetch | undefined;
}): Promise<string> {
	const appId =
		input.relay && (await readMaterial(input.relay.port, GITHUB_APP_ID_ENTRY));
	const privateKey =
		input.relay &&
		(await readMaterial(input.relay.port, GITHUB_APP_PRIVATE_KEY_ENTRY));
	if (!appId || !privateKey)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-missing");
	const app = createGithubAppTransport({
		appId: appId.trim(),
		privateKey,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
	const installation = await app
		.appRequest(
			`/repos/${input.repository.owner}/${input.repository.repo}/installation`,
		)
		.catch(() => undefined);
	if (installation === undefined || installation.status >= 500)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	if (installation.status === 404)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-not-installed");
	const parsed = installation.ok
		? RepositoryInstallation.safeParse(
				await installation.json().catch(() => undefined),
			)
		: undefined;
	if (parsed === undefined || !parsed.success)
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	return app.installationToken(parsed.data.id).catch(() => {
		throw new OwnerCredentialUnavailable(input.ref, "github-app-refused");
	});
}

export function createOwnerStoreSessions(options: {
	readonly signIn: OwnerSignIn;
	readonly relayFolder?: OwnerRelayFolder;
	readonly fetch?: typeof fetch;
	readonly kept?: TrustedVault;
	readonly keptFor?: (cwd: string, family: "ci" | "cd") => TrustedVault;
	readonly agentVault?: AgentVaultProxyDeps;
}): OwnerStoreSessions {
	const held = new Map<string, Held>();
	const closing = new Set<Promise<void>>();
	const revisions = new Map<string, number>();
	let closed = false;
	const keyOf = (cwd: string) => {
		const absolute = path.resolve(cwd);
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	};
	const drop = (key: string) => {
		const current = held.get(key);
		current?.vault.clear();
		held.delete(key);
		const ending = current?.broker?.close().catch(() => undefined);
		if (ending !== undefined) {
			closing.add(ending);
			void ending.finally(() => closing.delete(ending));
		}
	};
	const brokerFor = (store: OpenedSecretStore) =>
		store.agentVault !== undefined && options.agentVault !== undefined
			? createAgentVaultBroker({
					vault: store.agentVault,
					...options.agentVault,
				})
			: undefined;
	return {
		async establish(cwd, signIn, family = "cd") {
			const key = keyOf(cwd);
			const revision = revisions.get(key) ?? 0;
			const vault = createTrustedVault();
			if (closed)
				return {
					status: "sign-in-needed",
					store: "Infisical",
					code: "HOBO_OWNER_SESSION_CLOSED",
				};
			for (const name of [
				"INFISICAL_TOKEN",
				"OP_CONNECT_TOKEN",
				"BW_CLIENTID",
				"BW_CLIENTSECRET",
			] as const) {
				const value = signIn?.[name];
				if (value !== undefined) vault.put(name, value);
			}
			let outcome: OwnerSignInOutcome;
			try {
				outcome = await options.signIn({
					cwd: key,
					vault,
					family,
					...(signIn?.INFISICAL_CLI_SESSION === undefined
						? undefined
						: { infisicalSession: signIn.INFISICAL_CLI_SESSION }),
				});
			} catch {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: "Infisical",
					code: "HOBO_OWNER_STORE_UNAVAILABLE",
				};
			}
			if (closed || (revisions.get(key) ?? 0) !== revision) {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: "Infisical",
					code: "HOBO_OWNER_SESSION_CHANGED",
				};
			}
			if (outcome.kind === "refused") {
				vault.clear();
				const current = held.get(key);
				return {
					status: "sign-in-needed",
					store: current?.label ?? "Infisical",
					code: outcome.code,
					reason: publicReason(outcome.message),
				};
			}
			const owner = outcome.owner;
			if (!owner.chosen) {
				vault.clear();
				return { status: "unchosen" };
			}
			const label = labelOf(owner.id);
			if (owner.opened === undefined) {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: label,
					code: "HOBO_OWNER_SIGN_IN",
				};
			}
			try {
				const kept = options.keptFor?.(key, family) ?? options.kept;
				for (const name of KEPT_STORE_SIGN_INS) {
					const value = vault.reveal(name);
					if (value !== undefined) kept?.put(name, value);
				}
			} catch {
				vault.clear();
				return {
					status: "sign-in-needed",
					store: label,
					code: "HOBO_OWNER_SESSION_CHANGED",
				};
			}
			drop(key);
			held.set(key, {
				store: owner.opened,
				vault,
				label,
				broker: brokerFor(owner.opened),
			});
			return { status: "established", store: label };
		},
		invalidate(cwd) {
			const key = keyOf(cwd);
			revisions.set(key, (revisions.get(key) ?? 0) + 1);
			drop(key);
		},
		status(cwd) {
			const current = held.get(keyOf(cwd));
			if (current === undefined) return { established: false };
			const agentVault = current.broker?.status();
			return agentVault === undefined
				? { established: true, store: current.label }
				: { established: true, store: current.label, agentVault };
		},
		agentVault(cwd) {
			const key = keyOf(cwd);
			if (held.get(key)?.broker === undefined) return undefined;
			return async (host) => {
				const broker = held.get(key)?.broker;
				return broker === undefined
					? {
							ok: false,
							refusal: {
								code: "HOBO_AGENT_VAULT_UNAVAILABLE",
								message:
									"The owner's store session closed before Agent Vault was reached.",
								remediation: [
									"Run HoBo MCP's choose_secret_store again, then ask again.",
								],
							},
						}
					: broker.route(host);
			};
		},
		credentials(cwd) {
			const key = keyOf(cwd);
			return {
				async resolve(ref) {
					const repository = parseGithubAppInstallationRef(ref);
					const name = repository === undefined ? entryOf(ref) : undefined;
					const current = held.get(key);
					if (current === undefined)
						throw new OwnerCredentialUnavailable(ref, "no-session");
					if (repository !== undefined) {
						const relay = await options
							.relayFolder?.({ cwd: key, vault: current.vault })
							.catch(() => undefined);
						return {
							token: await mintInstallationToken({
								ref,
								repository,
								relay,
								fetch: options.fetch,
							}),
						};
					}
					const material =
						name === undefined
							? undefined
							: await readMaterial(current.store.port, name);
					if (material === undefined)
						throw new OwnerCredentialUnavailable(ref, "not-in-store");
					return { token: material };
				},
			};
		},
		entries(cwd) {
			const key = keyOf(cwd);
			const opened = (name: string) => {
				const ref = `${OWNER_CREDENTIAL_SCHEME}${entryOf(`${OWNER_CREDENTIAL_SCHEME}${name}`)}`;
				const current = held.get(key);
				if (current === undefined)
					throw new OwnerCredentialUnavailable(ref, "no-session");
				return current.store.port;
			};
			return {
				async read(name) {
					return readMaterial(opened(name), name);
				},
				async write(name, value) {
					await opened(name).put(name, value);
				},
			};
		},
		async close() {
			closed = true;
			for (const key of held.keys()) drop(key);
			await Promise.all(closing);
		},
	};
}

export type RelayCredentialSource = Readonly<{
	held():
		| { readonly expiresAt: number; readonly credentials: CredentialResolver }
		| undefined;
	now(): number;
}>;

export function withRelaySession(
	sessions: OwnerStoreSessions,
	relay: RelayCredentialSource,
): OwnerStoreSessions {
	return {
		...sessions,
		status(cwd) {
			const store = sessions.status(cwd);
			const held = relay.held();
			return held === undefined
				? store
				: {
						...store,
						relaySession: {
							expiresInSeconds: Math.max(
								0,
								Math.floor((held.expiresAt - relay.now()) / 1000),
							),
						},
					};
		},
		credentials(cwd) {
			const store = sessions.credentials(cwd);
			return {
				async resolve(ref, scope) {
					const held = relay.held();
					return held === undefined || sessions.status(cwd).established
						? store.resolve(ref, scope)
						: held.credentials.resolve(ref, scope);
				},
			};
		},
	};
}
