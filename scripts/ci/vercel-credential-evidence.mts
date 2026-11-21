#!/usr/bin/env node
/** Read-only, trusted-main observation of two explicitly named GitHub secrets. */
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	parseSecretRef,
	SecretValue,
} from "../../packages/bindings/dist/index.js";
import {
	createFetchTransport,
	createGuardedTransport,
} from "../../packages/providers/provider-vercel/dist/index.js";

const repository = "Hobo-Labs/HoBo";
const workflowRef = `${repository}/.github/workflows/vercel-credential-evidence.yml@refs/heads/main`;
const teamId = "team_BRBUnG6uGhSsVV3EG5GFV3FM";
const projectId = "prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO";
const projectSchema = z
	.object({
		id: z.literal(projectId),
		accountId: z.literal(teamId),
		name: z.literal("hobo-ci"),
	})
	.passthrough();
const candidates = [
	{ name: "VERCEL_TOKEN", env: "HOBO_VERCEL_TOKEN_CANDIDATE" },
	{ name: "VERCEL_ACCESS_TOKEN", env: "HOBO_VERCEL_ACCESS_TOKEN_CANDIDATE" },
] as const;

export type VercelCredentialEvidenceReport = Readonly<{
	status: "observed" | "unavailable";
	credentials: readonly Readonly<{
		name: (typeof candidates)[number]["name"];
		present: boolean;
		projectRead: "verified" | "unverified" | "not-observed";
	}>[];
	ciCanDeploy: "not-evaluated";
	cdCanDeploy: "not-evaluated";
}>;

function unavailable(): VercelCredentialEvidenceReport {
	return {
		status: "unavailable",
		credentials: [],
		ciCanDeploy: "not-evaluated",
		cdCanDeploy: "not-evaluated",
	};
}

/** Environment checks narrow the caller; GitHub's job boundary supplies secrets. */
export function trustedVercelEvidenceContext(
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

/** No values, token fingerprints, provider errors or deployment claims leave this function. */
export async function inspectVercelCredentials(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof globalThis.fetch;
}): Promise<VercelCredentialEvidenceReport> {
	if (!trustedVercelEvidenceContext(input.env)) return unavailable();
	const transport = createGuardedTransport(
		createFetchTransport({ fetchImpl: input.fetch ?? fetch }),
		{
			allowedHosts: ["api.vercel.com"],
			allowedPathPrefixes: ["/v9/projects/"],
			maxResponseBytes: 65_536,
			timeoutMs: 10_000,
		},
	);
	const rows: Array<VercelCredentialEvidenceReport["credentials"][number]> = [];
	for (const candidate of candidates) {
		const material = input.env[candidate.env] ?? "";
		if (!material) {
			rows.push({
				name: candidate.name,
				present: false,
				projectRead: "not-observed",
			});
			continue;
		}
		let projectRead: "verified" | "unverified" = "unverified";
		try {
			if (!/^[\x21-\x7e]{1,4096}$/u.test(material))
				throw new Error("invalid candidate");
			const token = new SecretValue(
				parseSecretRef(`hobo-token://vercel/evidence/${candidate.name}`),
				material,
			);
			const response = await transport.request({
				method: "GET",
				url: `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`,
				headers: {
					authorization: `Bearer ${token.expose()}`,
					accept: "application/json",
				},
				timeoutMs: 10_000,
				maxResponseBytes: 65_536,
			});
			if (
				response.status === 200 &&
				projectSchema.safeParse(JSON.parse(response.body)).success
			)
				projectRead = "verified";
		} catch {
			// An inaccessible or invalid credential is not proof of absence or permission.
		}
		rows.push({ name: candidate.name, present: true, projectRead });
	}
	return {
		status: "observed",
		credentials: rows,
		ciCanDeploy: "not-evaluated",
		cdCanDeploy: "not-evaluated",
	};
}

async function main() {
	const report = await inspectVercelCredentials({ env: process.env });
	process.stdout.write(`${JSON.stringify(report)}\n`);
	if (report.status !== "observed") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
