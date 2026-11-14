#!/usr/bin/env node
/** Read only names from the committed Infisical binding using GitHub OIDC. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	createInfisicalClient,
	githubActionsJwtSource,
	oidcAuth,
	parseInfisicalBinding,
} from "../../packages/adapters/adapter-infisical/dist/index.js";
import { readSecretStoreBinding } from "../../packages/secret-store-claim/dist/index.js";

const repository = "Hobo-Labs/HoBo";
const workflowRef = `${repository}/.github/workflows/hosting-evidence.yml@refs/heads/main`;
const knownNames = [
	"HOBO_CI_CONFIG_JSON",
	"HOBO_CI_CONTROL_TOKENS_JSON",
	"HOBO_CI_GITHUB_APP_ID",
	"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
	"HOBO_HOSTING_SDK_ENROLLMENT",
	"VERCEL_TOKEN",
	"CLOUDFLARE_API_TOKEN",
	"SUPABASE_ACCESS_TOKEN",
	"UPSTASH_API_KEY",
] as const;
const projectMetadata = z.object({
	project: z.object({
		id: z.string(),
		environments: z
			.array(
				z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u) }),
			)
			.max(16),
	}),
});
const folderMetadata = z.object({
	folders: z
		.array(
			z.object({
				name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
			}),
		)
		.max(64),
});

export type HostingEvidenceReport = Readonly<{
	status: "observed" | "unavailable";
	storeAccess: "names-only" | "unverified";
	knownNamesPresent: readonly string[];
	scopeDiscovery: "observed" | "partial" | "unavailable";
	knownLocations: readonly Readonly<{
		environment: string;
		path: string;
		names: readonly string[];
	}>[];
	/** GitHub App IDs are public numeric identifiers, not credentials. */
	ciGithubAppId?: string;
	ciCanDeploy: "not-evaluated";
	cdCanDeploy: "not-evaluated";
}>;

function unavailable(): HostingEvidenceReport {
	return {
		status: "unavailable",
		storeAccess: "unverified",
		knownNamesPresent: [],
		scopeDiscovery: "unavailable",
		knownLocations: [],
		ciCanDeploy: "not-evaluated",
		cdCanDeploy: "not-evaluated",
	};
}

/** Environment is only a preliminary boundary; Infisical validates the OIDC identity. */
export function trustedMainContext(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return (
		env.GITHUB_ACTIONS === "true" &&
		env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
		env.GITHUB_REPOSITORY === repository &&
		env.GITHUB_REPOSITORY_ID === "1274791462" &&
		env.GITHUB_REPOSITORY_OWNER_ID === "344805935" &&
		env.GITHUB_REF === "refs/heads/main" &&
		env.GITHUB_WORKFLOW_REF === workflowRef &&
		/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "")
	);
}

/** Each allowed request is made at most once; no other provider URL is allowed. */
function limitedTransport(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly endpoint: string;
	readonly projectId: string;
	readonly environment: string;
	readonly secretPath: string;
	readonly identityId: string;
	readonly fetch: typeof fetch;
}) {
	const oidcUrl = new URL(input.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
	if (
		oidcUrl.protocol !== "https:" ||
		!oidcUrl.hostname.endsWith(".actions.githubusercontent.com") ||
		oidcUrl.username ||
		oidcUrl.password ||
		oidcUrl.hash ||
		!input.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	)
		throw new Error("GitHub OIDC request is unavailable");
	oidcUrl.searchParams.set("audience", "https://github.com/Hobo-Labs");
	const loginUrl = `${input.endpoint}/api/v1/auth/oidc-auth/login`;
	const seen = new Set<string>();
	const allowedScopes = new Set([
		JSON.stringify([input.environment, input.secretPath]),
	]);
	let authorization: string | undefined;
	const sdkFetch: typeof fetch = async (resource, init) => {
		const url = String(resource);
		const parsed = new URL(url);
		let operation: string;
		if (url === oidcUrl.href && (init?.method ?? "GET") === "GET")
			operation = "oidc";
		else if (url === loginUrl && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			if (
				!body ||
				Object.keys(body).sort().join(",") !== "identityId,jwt" ||
				body.identityId !== input.identityId
			)
				throw new Error("invalid identity login");
			operation = "login";
		} else if (
			parsed.origin === input.endpoint &&
			init?.method === "GET" &&
			parsed.pathname === "/api/v4/secrets"
		) {
			const q = parsed.searchParams;
			const environment = q.get("environment"),
				path = q.get("secretPath");
			if (
				q.get("projectId") !== input.projectId ||
				!environment ||
				!path ||
				!allowedScopes.has(JSON.stringify([environment, path])) ||
				q.get("viewSecretValue") !== "false" ||
				q.get("recursive") !== "false" ||
				q.get("includeImports") !== "false" ||
				q.get("expandSecretReferences") !== "false" ||
				[...q.keys()].sort().join(",") !==
					"environment,expandSecretReferences,includeImports,projectId,recursive,secretPath,viewSecretValue"
			)
				throw new Error("invalid names-only scope");
			operation = `list:${environment}:${path}`;
			authorization =
				new Headers(init.headers).get("authorization") ?? undefined;
		} else if (
			parsed.origin === input.endpoint &&
			init?.method === "GET" &&
			parsed.pathname === "/api/v4/secrets/HOBO_CI_GITHUB_APP_ID"
		) {
			const q = parsed.searchParams;
			if (
				q.get("projectId") !== input.projectId ||
				q.get("environment") !== input.environment ||
				q.get("secretPath") !== input.secretPath ||
				q.get("type") !== "shared" ||
				q.get("viewSecretValue") !== "true" ||
				q.get("includeImports") !== "false" ||
				q.get("expandSecretReferences") !== "false" ||
				[...q.keys()].sort().join(",") !==
					"environment,expandSecretReferences,includeImports,projectId,secretPath,type,viewSecretValue"
			)
				throw new Error("invalid public App ID request");
			operation = "public-app-id";
		} else throw new Error("request outside the read-only observation");
		if (init?.redirect !== "error" || seen.has(operation))
			throw new Error("observation request refused");
		seen.add(operation);
		return input.fetch(resource, init);
	};
	async function readMetadata<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
		if (!authorization || !/^Bearer [!-~]{1,16384}$/u.test(authorization))
			throw new Error("identity unavailable");
		const response = await input.fetch(url, {
			method: "GET",
			headers: { authorization },
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok || !response.body) throw new Error("metadata unavailable");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const row = await reader.read();
				if (row.done) break;
				size += row.value.byteLength;
				if (size > 1_048_576) {
					await reader.cancel();
					throw new Error("metadata too large");
				}
				chunks.push(row.value);
			}
		} finally {
			reader.releaseLock();
		}
		return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	}
	async function discover() {
		const project = await readMetadata(
			new URL(
				`${input.endpoint}/api/v1/projects/${encodeURIComponent(input.projectId)}`,
			),
			projectMetadata,
		);
		if (project.project.id !== input.projectId)
			throw new Error("project metadata invalid");
		const environments = project.project.environments.map((row) => row.slug);
		if (new Set(environments).size !== environments.length)
			throw new Error("duplicate environment");
		const queue = environments.map((environment) => ({
			environment,
			path: "/",
			depth: 0,
		}));
		if (input.secretPath !== "/" && environments.includes(input.environment))
			queue.push({
				environment: input.environment,
				path: input.secretPath,
				depth: 0,
			});
		const approved: { environment: string; path: string }[] = [];
		const visited = new Set<string>();
		let partial = false,
			requests = 0;
		while (queue.length && requests < 16) {
			const item = queue.shift();
			if (!item) break;
			const identity = JSON.stringify([item.environment, item.path]);
			if (visited.has(identity)) continue;
			visited.add(identity);
			requests++;
			try {
				const url = new URL(`${input.endpoint}/api/v2/folders`);
				url.search = new URLSearchParams({
					projectId: input.projectId,
					environment: item.environment,
					path: item.path,
					recursive: "false",
				}).toString();
				const answer = await readMetadata(url, folderMetadata);
				allowedScopes.add(JSON.stringify([item.environment, item.path]));
				approved.push({ environment: item.environment, path: item.path });
				if (item.depth >= 5 && answer.folders.length) {
					partial = true;
					continue;
				}
				for (const folder of answer.folders) {
					const path =
						item.path === "/"
							? `/${folder.name}`
							: `${item.path}/${folder.name}`;
					if (path.length > 512) throw new Error("folder path too long");
					queue.push({
						environment: item.environment,
						path,
						depth: item.depth + 1,
					});
				}
			} catch {
				partial = true;
			}
		}
		if (queue.length) partial = true;
		return { approved, partial };
	}
	return { sdkFetch, discover };
}

/** The result reports only known key names, never values or inferred permissions. */
export async function inspectHostingEvidence(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly bindingText: string;
	readonly fetch?: typeof fetch;
}): Promise<HostingEvidenceReport> {
	if (!trustedMainContext(input.env)) return unavailable();
	try {
		const store = readSecretStoreBinding(input.bindingText);
		if (
			store.kind !== "infisical-cloud-attach" ||
			store.claimState !== "claimed" ||
			store.endpoint !== "https://app.infisical.com"
		)
			return unavailable();
		const binding = parseInfisicalBinding({
			siteUrl: store.endpoint,
			projectId: store.projectId,
			environment: store.environment,
			secretPath: store.secretPath,
		});
		const transport = limitedTransport({
			env: input.env,
			endpoint: binding.siteUrl,
			projectId: binding.projectId,
			environment: binding.environment,
			secretPath: binding.secretPath,
			identityId: store.deployIdentityId,
			fetch: input.fetch ?? fetch,
		});
		const client = createInfisicalClient({
			binding,
			auth: oidcAuth({
				identityId: store.deployIdentityId,
				jwt: githubActionsJwtSource({
					env: input.env,
					audience: "https://github.com/Hobo-Labs",
					fetch: transport.sdkFetch,
				}),
			}),
			fetch: transport.sdkFetch,
			retry: { attempts: 1 },
		});
		try {
			const names = new Set(
				(await client.listSecretNames()).map((row) => row.secretKey),
			);
			const knownNamesPresent = knownNames.filter((name) => names.has(name));
			const knownLocations: {
				environment: string;
				path: string;
				names: readonly string[];
			}[] = knownNamesPresent.length
				? [
						{
							environment: binding.environment,
							path: binding.secretPath,
							names: knownNamesPresent,
						},
					]
				: [];
			let scopeDiscovery: HostingEvidenceReport["scopeDiscovery"] =
				"unavailable";
			let ciGithubAppId: string | undefined;
			if (names.has("HOBO_CI_GITHUB_APP_ID")) {
				try {
					const candidate = (await client.getSecret("HOBO_CI_GITHUB_APP_ID"))
						.value;
					if (/^[1-9]\d{0,14}$/u.test(candidate)) ciGithubAppId = candidate;
				} catch {
					/* No secret value or provider error is reported. */
				}
			}
			try {
				const discovered = await transport.discover();
				scopeDiscovery = discovered.partial ? "partial" : "observed";
				for (const scope of discovered.approved) {
					if (
						scope.environment === binding.environment &&
						scope.path === binding.secretPath
					)
						continue;
					try {
						const scoped = client.forBinding(
							parseInfisicalBinding({
								...binding,
								environment: scope.environment,
								secretPath: scope.path,
							}),
						);
						const seen = new Set(
							(await scoped.listSecretNames()).map((row) => row.secretKey),
						);
						const matches = knownNames.filter((name) => seen.has(name));
						if (matches.length)
							knownLocations.push({
								environment: scope.environment,
								path: scope.path,
								names: matches,
							});
					} catch {
						scopeDiscovery = "partial";
					}
				}
			} catch {
				/* Project metadata is optional and never implies access. */
			}
			const report: HostingEvidenceReport = {
				status: "observed",
				storeAccess: "names-only",
				knownNamesPresent,
				scopeDiscovery,
				knownLocations,
				ciCanDeploy: "not-evaluated",
				cdCanDeploy: "not-evaluated",
			};
			return ciGithubAppId ? { ...report, ciGithubAppId } : report;
		} finally {
			client.signOut();
		}
	} catch {
		// Never print provider errors, token material, response bodies or unknown names.
		return unavailable();
	}
}

async function main() {
	let report = unavailable();
	try {
		report = await inspectHostingEvidence({
			env: process.env,
			bindingText: await readFile(
				"packages/ci-vercel/deploy/secret-store.binding.json",
				"utf8",
			),
		});
	} catch {}
	process.stdout.write(`${JSON.stringify(report)}\n`);
	if (report.status !== "observed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
