import {
	create,
	type DescMessage,
	fromJson,
	type JsonValue,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	InfisicalAgentVaultCertificateAuthorityResponseSchema,
	InfisicalAgentVaultCreateProxyRequestSchema,
	InfisicalAgentVaultCreateSessionRequestSchema,
	InfisicalAgentVaultProjectListSchema,
	type InfisicalAgentVaultProxy,
	InfisicalAgentVaultProxyListSchema,
	InfisicalAgentVaultProxyTokenResponseSchema,
	InfisicalAgentVaultServiceListSchema,
	InfisicalAgentVaultSessionResponseSchema,
	InfisicalAgentVaultSessionServiceListSchema,
} from "./_generated/adapter_infisical_pb.js";
import { InfisicalError } from "./errors.js";

export type AgentVaultCall = (
	operation: string,
	method: "GET" | "POST",
	path: string,
	payload?: string,
) => Promise<JsonValue>;

export type AgentVaultSessionCall = (
	operation: string,
	sessionToken: string,
	path: string,
) => Promise<JsonValue>;

const SERVICE_TYPES = ["http", "mcp", "postgres", "mysql", "ssh"] as const;
export type AgentVaultServiceType = (typeof SERVICE_TYPES)[number];

const CREDENTIAL_TYPES = ["bearer", "oauth", "basic", "login", "none"] as const;
export type AgentVaultCredentialType = (typeof CREDENTIAL_TYPES)[number];

export type AgentVaultProject = Readonly<{ id: string; name: string }>;

export type AgentVaultService = Readonly<{
	name: string;
	type: AgentVaultServiceType;
	hosts: readonly string[];
}>;

export type AgentVaultProxy = Readonly<{
	id: string;
	name: string;
	healthy: boolean;
}>;

export type AgentVaultProxyStart = Readonly<{
	proxy: AgentVaultProxy;
	proxyToken: string;
}>;

export type AgentVaultCertificateAuthority = Readonly<{
	certificate: string;
	fingerprint: string;
}>;

export type AgentVaultSession = Readonly<{
	id: string;
	token: string;
	expiresAt: string | undefined;
}>;

export type AgentVaultSessionService = Readonly<{
	name: string;
	type: AgentVaultServiceType;
	hosts: readonly string[];
	credential: Readonly<{
		type: AgentVaultCredentialType;
		header: string | undefined;
		addedByProxy: boolean;
	}>;
	placeholders: readonly Readonly<{
		placeholder: string;
		surfaces: readonly string[];
	}>[];
}>;

export interface InfisicalAgentVaultApi {
	listProjects(): Promise<readonly AgentVaultProject[]>;
	listServices(projectId: string): Promise<readonly AgentVaultService[]>;
	listProxies(projectId: string): Promise<readonly AgentVaultProxy[]>;
	createProxy(projectId: string, name: string): Promise<AgentVaultProxyStart>;
	rotateProxyToken(proxyId: string): Promise<AgentVaultProxyStart>;
	proxyCertificateAuthority(
		proxyId: string,
	): Promise<AgentVaultCertificateAuthority>;
	createSession(input: {
		readonly projectId: string;
		readonly services: readonly string[];
		readonly ttl: string;
		readonly label: string;
	}): Promise<AgentVaultSession>;
	revokeSession(sessionId: string): Promise<void>;
	sessionServices(
		sessionToken: string,
	): Promise<readonly AgentVaultSessionService[]>;
}

const ID = /^[A-Za-z0-9-]{1,64}$/u;
const NAME = /^[^\p{Cc}]{1,128}$/u;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const TOKEN = /^[!-~]{1,16384}$/u;
const TTL = /^[1-9][0-9]{0,4}[mhd]$/u;
const LABEL = /^[^\p{Cc}]{0,128}$/u;
const CERTIFICATE = /^-----BEGIN CERTIFICATE-----/u;
const HOST = /^(?:\*\.)?[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/u;
const PAGE = 100;
const MAX_OFFSET = 10_000;

function malformed(operation: string): never {
	throw new InfisicalError(operation, "invalid-response");
}

function parse<Desc extends DescMessage>(
	operation: string,
	schema: Desc,
	json: JsonValue,
): ReturnType<typeof fromJson<Desc>> {
	try {
		return fromJson(schema, json, { ignoreUnknownFields: true });
	} catch {
		return malformed(operation);
	}
}

function id(operation: string, value: string): string {
	return ID.test(value) ? value : malformed(operation);
}

function argument(operation: string, pattern: RegExp, value: string): string {
	if (!pattern.test(value))
		throw new InfisicalError(operation, "invalid-input");
	return value;
}

function serviceType(value: string): AgentVaultServiceType | undefined {
	return SERVICE_TYPES.find((type) => type === value);
}

function hostsOf(pattern: readonly string[]): readonly string[] {
	return Object.freeze(
		pattern
			.flatMap((entry) => entry.split(","))
			.map((host) => host.trim().toLowerCase())
			.filter((host) => HOST.test(host)),
	);
}

function proxyOf(
	operation: string,
	proxy: InfisicalAgentVaultProxy | undefined,
): AgentVaultProxy {
	if (proxy === undefined || !NAME.test(proxy.name)) malformed(operation);
	return Object.freeze({
		id: id(operation, proxy.id),
		name: proxy.name,
		healthy: proxy.isHealthy,
	});
}

export function createInfisicalAgentVaultApi(options: {
	readonly call: AgentVaultCall;
	readonly callAsSession: AgentVaultSessionCall;
}): InfisicalAgentVaultApi {
	const { call, callAsSession } = options;

	async function pages<T>(
		read: (offset: number) => Promise<readonly T[]>,
	): Promise<readonly T[]> {
		const all: T[] = [];
		for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE) {
			const page = await read(offset);
			all.push(...page);
			if (page.length < PAGE) break;
		}
		return Object.freeze(all);
	}

	function query(entries: Record<string, string | number>): string {
		return new URLSearchParams(
			Object.entries(entries).map(([key, value]) => [key, String(value)]),
		).toString();
	}

	async function proxyStart(
		operation: string,
		json: JsonValue,
	): Promise<AgentVaultProxyStart> {
		const answer = parse(
			operation,
			InfisicalAgentVaultProxyTokenResponseSchema,
			json,
		);
		if (!TOKEN.test(answer.proxyToken)) malformed(operation);
		return Object.freeze({
			proxy: proxyOf(operation, answer.proxy),
			proxyToken: answer.proxyToken,
		});
	}

	const api: InfisicalAgentVaultApi = {
		async listProjects() {
			const operation = "list agent vault projects";
			return pages(async (offset) => {
				const list = parse(
					operation,
					InfisicalAgentVaultProjectListSchema,
					await call(
						operation,
						"GET",
						`/api/v1/projects?${query({ type: "agent-vault", limit: PAGE, offset })}`,
					),
				);
				return list.projects
					.filter((project) => project.type === "agent-vault")
					.map((project) => {
						if (!NAME.test(project.name)) malformed(operation);
						return Object.freeze({
							id: id(operation, project.id),
							name: project.name,
						});
					});
			});
		},
		async listServices(projectId) {
			const operation = "list agent vault services";
			argument(operation, ID, projectId);
			return pages(async (offset) => {
				const list = parse(
					operation,
					InfisicalAgentVaultServiceListSchema,
					await call(
						operation,
						"GET",
						`/api/v1/agent-vault/services?${query({ projectId, limit: PAGE, offset })}`,
					),
				);
				return list.services.flatMap((service) => {
					if (!SERVICE_NAME.test(service.name)) malformed(operation);
					const type = serviceType(service.type);
					return type === undefined
						? []
						: [
								Object.freeze({
									name: service.name,
									type,
									hosts: hostsOf([service.hostPattern]),
								}),
							];
				});
			});
		},
		async listProxies(projectId) {
			const operation = "list agent vault proxies";
			argument(operation, ID, projectId);
			return pages(async (offset) => {
				const list = parse(
					operation,
					InfisicalAgentVaultProxyListSchema,
					await call(
						operation,
						"GET",
						`/api/v1/agent-vault/proxies?${query({ projectId, limit: PAGE, offset })}`,
					),
				);
				return list.proxies.map((proxy) => proxyOf(operation, proxy));
			});
		},
		async createProxy(projectId, name) {
			const operation = "create agent vault proxy";
			argument(operation, ID, projectId);
			argument(operation, SERVICE_NAME, name);
			return proxyStart(
				operation,
				await call(
					operation,
					"POST",
					"/api/v1/agent-vault/proxies",
					toJsonString(
						InfisicalAgentVaultCreateProxyRequestSchema,
						create(InfisicalAgentVaultCreateProxyRequestSchema, {
							projectId,
							name,
							description: "HoBo runs this proxy for its verbs.",
							trafficPolicy: "service-hosts",
							pollInterval: 10,
						}),
					),
				),
			);
		},
		async rotateProxyToken(proxyId) {
			const operation = "rotate agent vault proxy token";
			argument(operation, ID, proxyId);
			return proxyStart(
				operation,
				await call(
					operation,
					"POST",
					`/api/v1/agent-vault/proxies/${encodeURIComponent(proxyId)}/token-auth/proxy-token`,
				),
			);
		},
		async proxyCertificateAuthority(proxyId) {
			const operation = "read agent vault proxy certificate authority";
			argument(operation, ID, proxyId);
			const answer = parse(
				operation,
				InfisicalAgentVaultCertificateAuthorityResponseSchema,
				await call(
					operation,
					"GET",
					`/api/v1/agent-vault/proxies/${encodeURIComponent(proxyId)}/ca`,
				),
			);
			const ca = answer.ca;
			if (
				ca === undefined ||
				!CERTIFICATE.test(ca.certificate) ||
				ca.fingerprint === ""
			)
				malformed(operation);
			return Object.freeze({
				certificate: ca.certificate,
				fingerprint: ca.fingerprint,
			});
		},
		async createSession(input) {
			const operation = "create agent vault session";
			argument(operation, ID, input.projectId);
			argument(operation, TTL, input.ttl);
			argument(operation, LABEL, input.label);
			if (input.services.length === 0)
				throw new InfisicalError(operation, "invalid-input");
			for (const service of input.services)
				argument(operation, SERVICE_NAME, service);
			const answer = parse(
				operation,
				InfisicalAgentVaultSessionResponseSchema,
				await call(
					operation,
					"POST",
					"/api/v1/agent-vault/sessions",
					toJsonString(
						InfisicalAgentVaultCreateSessionRequestSchema,
						create(InfisicalAgentVaultCreateSessionRequestSchema, {
							projectId: input.projectId,
							services: [...input.services],
							ttl: input.ttl,
							label: input.label,
						}),
					),
				),
			);
			const session = answer.session;
			if (session === undefined || !TOKEN.test(session.token))
				malformed(operation);
			return Object.freeze({
				id: id(operation, session.id),
				token: session.token,
				expiresAt: session.expiresAt === "" ? undefined : session.expiresAt,
			});
		},
		async revokeSession(sessionId) {
			const operation = "revoke agent vault session";
			argument(operation, ID, sessionId);
			await call(
				operation,
				"POST",
				`/api/v1/agent-vault/sessions/${encodeURIComponent(sessionId)}/revoke`,
			);
		},
		async sessionServices(sessionToken) {
			const operation = "list agent vault session services";
			argument(operation, TOKEN, sessionToken);
			const list = parse(
				operation,
				InfisicalAgentVaultSessionServiceListSchema,
				await callAsSession(
					operation,
					sessionToken,
					"/api/v1/agent-vault/session/services",
				),
			);
			return Object.freeze(
				list.services.flatMap((service) => {
					const type = serviceType(service.type);
					const credentialType = CREDENTIAL_TYPES.find(
						(candidate) => candidate === service.credential?.type,
					);
					if (
						!SERVICE_NAME.test(service.name) ||
						service.credential === undefined ||
						credentialType === undefined
					)
						malformed(operation);
					if (type === undefined) return [];
					return [
						Object.freeze({
							name: service.name,
							type,
							hosts: hostsOf(service.hosts),
							credential: Object.freeze({
								type: credentialType,
								header:
									service.credential.header === ""
										? undefined
										: service.credential.header,
								addedByProxy: service.credential.addedByProxy,
							}),
							placeholders: Object.freeze(
								service.placeholders.map((entry) => {
									if (!TOKEN.test(entry.placeholder)) malformed(operation);
									return Object.freeze({
										placeholder: entry.placeholder,
										surfaces: Object.freeze([...entry.surfaces]),
									});
								}),
							),
						}),
					];
				}),
			);
		},
	};
	return Object.freeze(api);
}
