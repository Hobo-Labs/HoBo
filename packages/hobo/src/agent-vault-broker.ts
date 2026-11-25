import {
	type AgentVaultService,
	type AgentVaultSessionService,
	InfisicalError,
} from "@hobo/adapter-infisical";
import { createBoundedFetchTransport, type HttpTransport } from "@hobo/core";
import {
	type AgentVaultProxyProcess,
	AgentVaultProxyStartError,
	agentVaultProxyFetch,
	type LaunchAgentVaultProxy,
	type OwnerAgentVault,
} from "@hobo/hobo-ci";

// public-contract: the name of the Agent Vault proxy HoBo registers and runs in the owner's project.
export const AGENT_VAULT_PROXY_NAME = "hobo";
const SESSION_TTL = "1h";
const SESSION_TTL_MS = 60 * 60 * 1000;
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const SESSION_LABEL = "hobo";
const CLOSED = "The owner's store session closed.";

export type AgentVaultRefusalCode =
	| "HOBO_AGENT_VAULT_UNAVAILABLE"
	| "HOBO_AGENT_VAULT_PROJECT_AMBIGUOUS"
	| "HOBO_AGENT_VAULT_NO_SERVICE"
	| "HOBO_AGENT_VAULT_NO_CREDENTIAL"
	| "HOBO_AGENT_VAULT_PROXY_FAILED"
	| "HOBO_AGENT_VAULT_FAILED";

export type AgentVaultRefusal = Readonly<{
	code: AgentVaultRefusalCode;
	message: string;
	remediation: readonly string[];
}>;

export type AgentVaultRoute = Readonly<{
	service: string;
	hosts: readonly string[];
	transport: HttpTransport;
	credential: string | undefined;
}>;

export type AgentVaultResolution =
	| Readonly<{ ok: true; route: AgentVaultRoute }>
	| Readonly<{ ok: false; refusal: AgentVaultRefusal }>;

export type AgentVaultRouter = (host: string) => Promise<AgentVaultResolution>;

export type AgentVaultStatus = Readonly<{
	project: string;
	services: readonly Readonly<{ name: string; hosts: readonly string[] }>[];
	proxy: Readonly<{ name: string; healthy: boolean }>;
}>;

export interface AgentVaultBroker {
	readonly route: AgentVaultRouter;
	status(): AgentVaultStatus | undefined;
	close(): Promise<void>;
}

export type AgentVaultProxyDeps = Readonly<{
	launch: LaunchAgentVaultProxy;
	command: () => Promise<string>;
	fetchThrough?: typeof agentVaultProxyFetch;
	now?: () => number;
}>;

class Refused extends Error {
	constructor(readonly refusal: AgentVaultRefusal) {
		super(refusal.message);
		this.name = "AgentVaultRefused";
	}
}

function refuse(
	code: AgentVaultRefusalCode,
	message: string,
	remediation: readonly string[] = [],
): never {
	throw new Refused({ code, message, remediation });
}

type Discovered = Readonly<{
	projectId: string;
	project: string;
	services: readonly AgentVaultService[];
}>;

type Opened = Readonly<{
	services: readonly string[];
	sessionId: string;
	credentials: ReadonlyMap<string, ServiceCredential>;
	proxy: AgentVaultProxyProcess;
	transport: HttpTransport;
	closeFetch: () => Promise<void>;
	renewAtMs: number;
}>;

type ServiceCredential = Readonly<{
	addedByProxy: boolean;
	placeholder: string | undefined;
}>;

function credentialOf(
	described: readonly AgentVaultSessionService[],
	service: string,
): ServiceCredential {
	const entry = described.find((candidate) => candidate.name === service);
	const placeholder = entry?.placeholders.find((candidate) =>
		candidate.surfaces.includes("header"),
	)?.placeholder;
	if (
		entry === undefined ||
		(!entry.credential.addedByProxy && placeholder === undefined)
	)
		refuse(
			"HOBO_AGENT_VAULT_NO_CREDENTIAL",
			`The Agent Vault service ${service} neither adds a credential nor offers a header placeholder for one.`,
			[
				`Give the service ${service} a credential the proxy adds, or a placeholder it replaces in a header.`,
			],
		);
	return Object.freeze({
		addedByProxy: entry.credential.addedByProxy,
		placeholder: entry.credential.addedByProxy ? undefined : placeholder,
	});
}

function hostCovers(pattern: string, host: string): boolean {
	const [patternHost = "", patternPort = "443"] = pattern.split(":");
	const [wantedHost = "", wantedPort = "443"] = host.toLowerCase().split(":");
	if (patternPort !== wantedPort) return false;
	if (!patternHost.startsWith("*.")) return patternHost === wantedHost;
	const suffix = patternHost.slice(1);
	return (
		wantedHost.endsWith(suffix) &&
		!wantedHost.slice(0, -suffix.length).includes(".") &&
		wantedHost.length > suffix.length
	);
}

function refusalOf(error: InfisicalError): AgentVaultRefusal {
	return error.code === "forbidden" ||
		error.code === "unauthorized" ||
		error.code === "not-found" ||
		error.code === "login-denied"
		? {
				code: "HOBO_AGENT_VAULT_UNAVAILABLE",
				message: `Infisical refused HoBo's Agent Vault request (${error.code}): the signed-in identity is not an Agent Vault admin of the project and holds no access bundle that covers it.`,
				remediation: [
					"In Infisical, make the identity you signed in with an Agent Vault admin of the project, or grant it an access bundle with the service.",
				],
			}
		: {
				code: "HOBO_AGENT_VAULT_FAILED",
				message: `Infisical's Agent Vault answer could not be used (${error.code}).`,
				remediation: [
					"Ask again; if it keeps failing, check Infisical's status.",
				],
			};
}

function withoutAuthorization(inner: HttpTransport): HttpTransport {
	return (request) =>
		inner({
			...request,
			headers: Object.fromEntries(
				Object.entries(request.headers ?? {}).filter(
					([name]) => name.toLowerCase() !== "authorization",
				),
			),
		});
}

export function createAgentVaultBroker(
	options: Readonly<{ vault: OwnerAgentVault }> & AgentVaultProxyDeps,
): AgentVaultBroker {
	const { api, siteUrl } = options.vault;
	const now = options.now ?? Date.now;
	const fetchThrough = options.fetchThrough ?? agentVaultProxyFetch;
	let discovered: Promise<Discovered> | undefined;
	let known: Discovered | undefined;
	let opened: Opened | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let closed = false;

	async function discover(): Promise<Discovered> {
		const projects = await api.listProjects();
		if (projects.length === 0)
			refuse(
				"HOBO_AGENT_VAULT_UNAVAILABLE",
				"The signed-in Infisical identity reaches no Agent Vault project.",
				[
					"Create an Agent Vault project in Infisical, or have its admin add the identity you signed in with.",
				],
			);
		const [project, ...others] = projects;
		if (project === undefined || others.length > 0)
			refuse(
				"HOBO_AGENT_VAULT_PROJECT_AMBIGUOUS",
				`The signed-in Infisical identity reaches ${projects.length} Agent Vault projects (${projects.map((entry) => JSON.stringify(entry.name)).join(", ")}); HoBo uses Agent Vault only when exactly one is reachable.`,
				[
					"Sign in with an identity that reaches only the Agent Vault project HoBo should use.",
				],
			);
		const services = await api.listServices(project.id);
		const found = Object.freeze({
			projectId: project.id,
			project: project.name,
			services,
		});
		known = found;
		return found;
	}

	async function shut(current: Opened | undefined): Promise<void> {
		if (current === undefined) return;
		await current.closeFetch();
		await api.revokeSession(current.sessionId).catch(() => undefined);
		await current.proxy.stop().catch(() => undefined);
	}

	async function open(
		project: Discovered,
		services: readonly string[],
	): Promise<Opened> {
		const session = await api.createSession({
			projectId: project.projectId,
			services,
			ttl: SESSION_TTL,
			label: SESSION_LABEL,
		});
		let proxy: AgentVaultProxyProcess | undefined;
		try {
			const described = await api.sessionServices(session.token);
			const credentials = new Map(
				services.map((service) => [service, credentialOf(described, service)]),
			);
			const proxies = await api.listProxies(project.projectId);
			const existing = proxies.find(
				(entry) => entry.name === AGENT_VAULT_PROXY_NAME,
			);
			const started =
				existing === undefined
					? await api.createProxy(project.projectId, AGENT_VAULT_PROXY_NAME)
					: await api.rotateProxyToken(existing.id);
			const authority = await api.proxyCertificateAuthority(started.proxy.id);
			const command = await options
				.command()
				.catch(() =>
					refuse(
						"HOBO_AGENT_VAULT_PROXY_FAILED",
						"The Infisical CLI that runs the Agent Vault proxy could not be found or installed.",
						[
							"Install @infisical/cli 0.45.14 or later, or let HoBo install it into its tools directory, then ask again.",
						],
					),
				);
			proxy = await options
				.launch({ command, siteUrl, proxyToken: started.proxyToken })
				.catch((error: unknown) =>
					refuse(
						"HOBO_AGENT_VAULT_PROXY_FAILED",
						error instanceof AgentVaultProxyStartError
							? error.message
							: "The Agent Vault proxy did not start.",
						[
							"Check that this machine reaches Infisical and that the Agent Vault proxy named hobo is not revoked, then ask again.",
						],
					),
				);
			const routed = fetchThrough({
				port: proxy.port,
				sessionToken: session.token,
				certificateAuthority: authority.certificate,
			});
			const expiresAtMs =
				session.expiresAt === undefined
					? Number.NaN
					: Date.parse(session.expiresAt);
			return Object.freeze({
				services,
				sessionId: session.id,
				credentials,
				proxy,
				transport: createBoundedFetchTransport({ fetchImpl: routed.fetch }),
				closeFetch: routed.close,
				renewAtMs:
					(Number.isFinite(expiresAtMs)
						? expiresAtMs
						: now() + SESSION_TTL_MS) - RENEW_BEFORE_MS,
			});
		} catch (error) {
			await proxy?.stop().catch(() => undefined);
			await api.revokeSession(session.id).catch(() => undefined);
			throw error;
		}
	}

	function openFor(project: Discovered, service: string): Promise<Opened> {
		const run = queue.then(async () => {
			const current = opened;
			if (current?.services.includes(service) && now() < current.renewAtMs)
				return current;
			if (closed) refuse("HOBO_AGENT_VAULT_UNAVAILABLE", CLOSED);
			const services = [
				...new Set([...(current?.services ?? []), service]),
			].sort();
			opened = undefined;
			await shut(current);
			const fresh = await open(project, services);
			opened = fresh;
			return fresh;
		});
		queue = run.catch(() => undefined);
		return run;
	}

	async function resolve(host: string): Promise<AgentVaultRoute> {
		discovered ??= discover().catch((error) => {
			discovered = undefined;
			throw error;
		});
		const project = await discovered;
		const service = project.services.find(
			(candidate) =>
				candidate.type === "http" &&
				candidate.hosts.some((pattern) => hostCovers(pattern, host)),
		);
		if (service === undefined)
			refuse(
				"HOBO_AGENT_VAULT_NO_SERVICE",
				`No http service in the Agent Vault project ${JSON.stringify(project.project)} covers ${host}.`,
				[
					`Add an http service for ${host} to the Agent Vault project ${JSON.stringify(project.project)}, with the credential the proxy adds.`,
				],
			);
		const current = await openFor(project, service.name);
		const credential = current.credentials.get(service.name);
		if (credential === undefined)
			refuse(
				"HOBO_AGENT_VAULT_FAILED",
				"The Agent Vault session does not carry the service it was opened for.",
				["Ask again."],
			);
		return Object.freeze({
			service: service.name,
			hosts: service.hosts,
			transport: credential.addedByProxy
				? withoutAuthorization(current.transport)
				: current.transport,
			credential: credential.placeholder,
		});
	}

	const broker: AgentVaultBroker = {
		async route(host) {
			if (closed)
				return {
					ok: false,
					refusal: {
						code: "HOBO_AGENT_VAULT_UNAVAILABLE",
						message: CLOSED,
						remediation: [],
					},
				};
			try {
				return { ok: true, route: await resolve(host) };
			} catch (error) {
				if (error instanceof Refused)
					return { ok: false, refusal: error.refusal };
				if (error instanceof InfisicalError)
					return { ok: false, refusal: refusalOf(error) };
				return {
					ok: false,
					refusal: {
						code: "HOBO_AGENT_VAULT_FAILED",
						message: "HoBo could not open the owner's Agent Vault route.",
						remediation: ["Ask again."],
					},
				};
			}
		},
		status() {
			if (known === undefined) return undefined;
			return Object.freeze({
				project: known.project,
				services: Object.freeze(
					known.services.map((service) =>
						Object.freeze({ name: service.name, hosts: service.hosts }),
					),
				),
				proxy: Object.freeze({
					name: AGENT_VAULT_PROXY_NAME,
					healthy: opened !== undefined,
				}),
			});
		},
		async close() {
			closed = true;
			await queue;
			const current = opened;
			opened = undefined;
			await shut(current);
		},
	};
	return Object.freeze(broker);
}
