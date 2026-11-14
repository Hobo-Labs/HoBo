#!/usr/bin/env node
/** Read only names from the committed Infisical binding using GitHub OIDC. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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

export type HostingEvidenceReport = Readonly<{
	status: "observed" | "unavailable";
	storeAccess: "names-only" | "unverified";
	knownNamesPresent: readonly string[];
	ciCanDeploy: "not-evaluated";
	cdCanDeploy: "not-evaluated";
}>;

function unavailable(): HostingEvidenceReport {
	return {
		status: "unavailable",
		storeAccess: "unverified",
		knownNamesPresent: [],
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
}): typeof fetch {
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
	const query = new URLSearchParams({
		projectId: input.projectId,
		environment: input.environment,
		secretPath: input.secretPath,
		viewSecretValue: "false",
		recursive: "false",
		expandSecretReferences: "false",
		includeImports: "false",
	});
	const listUrl = `${input.endpoint}/api/v4/secrets?${query}`;
	const loginUrl = `${input.endpoint}/api/v1/auth/oidc-auth/login`;
	const seen = new Set<string>();
	return async (resource, init) => {
		const url = String(resource);
		let operation: "oidc" | "login" | "list";
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
		} else if (url === listUrl && init?.method === "GET") operation = "list";
		else throw new Error("request outside the read-only observation");
		if (init?.redirect !== "error" || seen.has(operation))
			throw new Error("observation request refused");
		seen.add(operation);
		return input.fetch(resource, init);
	};
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
					fetch: transport,
				}),
			}),
			fetch: transport,
			retry: { attempts: 1 },
		});
		try {
			const names = new Set(
				(await client.listSecretNames()).map((row) => row.secretKey),
			);
			return {
				status: "observed",
				storeAccess: "names-only",
				knownNamesPresent: knownNames.filter((name) => names.has(name)),
				ciCanDeploy: "not-evaluated",
				cdCanDeploy: "not-evaluated",
			};
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
