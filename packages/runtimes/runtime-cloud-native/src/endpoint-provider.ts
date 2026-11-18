import type {
	FetchHandler,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";
import type { CloudNativeHostProvider } from "./host.js";

const ENDPOINT_BINDLE_ENV_PREFIX = "HOBO_CLOUD_NATIVE_ENDPOINT_";

export class CloudNativeEndpointError extends Error {
	readonly remediation: string;

	constructor(message: string, remediation: string) {
		super(`${message} — ${remediation}`);
		this.name = "CloudNativeEndpointError";
		this.remediation = remediation;
	}
}

interface ProviderDefinition {
	readonly id: "aws" | "gcp" | "azure" | "vercel";
	readonly isolationBoundary: string;
	readonly credentialAlternatives: readonly (readonly string[])[];
}

export interface EndpointCloudNativeProviderOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly fetchImpl?: typeof fetch;
}

const DEFINITIONS = Object.freeze({
	aws: Object.freeze({
		id: "aws",
		isolationBoundary: "aws-lambda",
		credentialAlternatives: Object.freeze([
			Object.freeze(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]),
			Object.freeze(["AWS_PROFILE"]),
			Object.freeze(["AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"]),
			Object.freeze(["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]),
		]),
	}),
	gcp: Object.freeze({
		id: "gcp",
		isolationBoundary: "gcp-cloud-run",
		credentialAlternatives: Object.freeze([
			Object.freeze(["GOOGLE_APPLICATION_CREDENTIALS"]),
			Object.freeze(["GOOGLE_APPLICATION_CREDENTIALS_JSON"]),
		]),
	}),
	azure: Object.freeze({
		id: "azure",
		isolationBoundary: "azure-functions",
		credentialAlternatives: Object.freeze([
			Object.freeze([
				"AZURE_CLIENT_ID",
				"AZURE_TENANT_ID",
				"AZURE_CLIENT_SECRET",
			]),
			Object.freeze([
				"AZURE_CLIENT_ID",
				"AZURE_TENANT_ID",
				"AZURE_FEDERATED_TOKEN_FILE",
			]),
			Object.freeze(["IDENTITY_ENDPOINT"]),
		]),
	}),
	vercel: Object.freeze({
		id: "vercel",
		isolationBoundary: "vercel-functions",
		credentialAlternatives: Object.freeze([Object.freeze(["VERCEL_TOKEN"])]),
	}),
} satisfies Record<string, ProviderDefinition>);

function endpointBindleKey(resourceName: string): string {
	return `${ENDPOINT_BINDLE_ENV_PREFIX}${resourceName
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")}`;
}

function parseEndpoint(
	providerId: string,
	resourceName: string,
	key: string,
	value: string,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CloudNativeEndpointError(
			`${providerId} endpoint for '${resourceName}' (${key}) is not a URL`,
			"Bind the key to the resource's deployed HTTP endpoint.",
		);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new CloudNativeEndpointError(
			`${providerId} endpoint for '${resourceName}' (${key}) must be http(s)`,
			"Bind the key to the resource's deployed HTTP endpoint.",
		);
	}
	return url;
}

function proxyHandler(endpoint: URL, fetchImpl: typeof fetch): FetchHandler {
	return async (request) => {
		const incoming = new URL(request.url);
		const target = new URL(endpoint);
		target.pathname = incoming.pathname;
		target.search = incoming.search;
		target.hash = "";
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			redirect: "manual",
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = await request.arrayBuffer();
		}
		const upstream = await fetchImpl(target, init);
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	};
}

function unboundHandler(
	providerId: string,
	resourceName: string,
): FetchHandler {
	const key = endpointBindleKey(resourceName);
	return async () =>
		Response.json(
			{
				error: `${providerId}-remote-handler-unbound`,
				resource: resourceName,
				remediation: `Deploy '${resourceName}' on ${providerId}, then bind bindleEnv['${key}'] to its public URL.`,
			},
			{ status: 501 },
		);
}

function missingCredentials(
	env: NodeJS.ProcessEnv,
	alternatives: readonly (readonly string[])[],
): readonly string[] {
	const missing = alternatives.map((names) =>
		names.filter((name) => !env[name]?.trim()),
	);
	if (missing.some((names) => names.length === 0)) return [];
	return missing.reduce((best, names) =>
		names.length < best.length ? names : best,
	);
}

function createEndpointCloudNativeProvider(
	definition: ProviderDefinition,
	options: EndpointCloudNativeProviderOptions,
): CloudNativeHostProvider {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		id: definition.id,
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			const env = options.env ?? ctx.env ?? process.env;
			const missing = missingCredentials(
				env,
				definition.credentialAlternatives,
			);
			if (missing.length > 0) {
				const note = `cloud-native provider '${definition.id}' is credential-gated: missing ${missing.join(", ")}`;
				ctx.emitProgress?.(`hobo: ${note}`);
				return {
					kind: "cloud-native",
					ready: false,
					notes: [note],
					details: {
						provider: definition.id,
						implemented: true,
						credentialGated: true,
						missing: [...missing],
					},
				};
			}
			const note = `cloud-native provider '${definition.id}' ready`;
			ctx.emitProgress?.(`hobo: ${note}`);
			return {
				kind: "cloud-native",
				ready: true,
				notes: [note],
				details: { provider: definition.id, implemented: true },
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const handlers = new Map<string, FetchHandler>();
			for (const component of ctx.privateComponents) {
				const key = endpointBindleKey(component.resourceName);
				const endpoint = ctx.bindleEnv?.[key];
				handlers.set(
					component.resourceName,
					endpoint === undefined
						? unboundHandler(definition.id, component.resourceName)
						: proxyHandler(
								parseEndpoint(
									definition.id,
									component.resourceName,
									key,
									endpoint,
								),
								fetchImpl,
							),
				);
			}
			return {
				kind: "cloud-native",
				handlers,
				isolation: {
					isolateBoundary: definition.isolationBoundary,
					privateSandboxes: 0,
					details: { mode: "remote-proxy" },
				},
				close: async () => {
					handlers.clear();
				},
			};
		},
	};
}

export function createAwsCloudNativeProvider(
	options: EndpointCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	return createEndpointCloudNativeProvider(DEFINITIONS.aws, options);
}

export function createGcpCloudNativeProvider(
	options: EndpointCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	return createEndpointCloudNativeProvider(DEFINITIONS.gcp, options);
}

export function createAzureCloudNativeProvider(
	options: EndpointCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	return createEndpointCloudNativeProvider(DEFINITIONS.azure, options);
}

export function createVercelCloudNativeProvider(
	options: EndpointCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	return createEndpointCloudNativeProvider(DEFINITIONS.vercel, options);
}
