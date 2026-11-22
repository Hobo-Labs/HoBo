#!/usr/bin/env node
import process from "node:process";

type Send = typeof fetch;

const repository = "Hobo-Labs/HoBo";
const environments = new Set(["hobo-ci-deploy", "hobo-ci-app-credentials"]);

async function getJson(send: Send, path: string, token: string) {
	const headers = new Headers({
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "hobo-relay-deploy",
	});
	if (token !== "") headers.set("authorization", `Bearer ${token}`);
	let response: Response;
	try {
		response = await send(`https://api.github.com${path}`, {
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		return { status: 0 };
	}
	if (response.status !== 200) return { status: response.status };
	try {
		return { status: 200, body: JSON.parse(await response.text()) };
	} catch {
		return { status: 200 };
	}
}

export async function verifyEnvironmentProtection(
	environment: string,
	send: Send = fetch,
	token = process.env.GITHUB_TOKEN?.trim() ?? "",
): Promise<Readonly<{ ok: boolean; detail: string }>> {
	if (!environments.has(environment))
		return { ok: false, detail: "unknown relay deploy environment" };
	const path = `/repos/${repository}/environments/${encodeURIComponent(environment)}`;
	const answer = await getJson(send, path, token);
	const body = answer.body;
	if (Object.prototype.toString.call(body) !== "[object Object]")
		return {
			ok: false,
			detail: `${path} ${answer.status === 0 ? "could not be reached" : `answered HTTP ${answer.status} without the required environment record`}`,
		};
	const branches = body.deployment_branch_policy;
	if (branches?.custom_branch_policies !== true)
		return {
			ok: false,
			detail: `${environment} must use a custom deployment branch policy restricted to main`,
		};
	const policiesAnswer = await getJson(
		send,
		`${path}/deployment-branch-policies`,
		token,
	);
	const policies = policiesAnswer.body?.branch_policies;
	if (
		!Array.isArray(policies) ||
		policies.length !== 1 ||
		policies[0]?.name !== "main" ||
		policies[0]?.type !== "branch"
	)
		return {
			ok: false,
			detail: `${environment} deployment branch policies must contain exactly the main branch`,
		};
	return {
		ok: true,
		detail: `${environment} deploys main only`,
	};
}

async function main(argv: readonly string[]): Promise<void> {
	const at = argv.indexOf("--environment");
	const environment = at === -1 ? "" : (argv[at + 1] ?? "");
	const result = await verifyEnvironmentProtection(environment);
	process.stdout.write(
		`::${result.ok ? "notice" : "error"} title=Relay environment protection::${result.detail}.\n`,
	);
	if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main(process.argv.slice(2));
}
