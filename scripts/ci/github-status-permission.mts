import { execFileSync } from "node:child_process";
import { asObject, asText, parseJson } from "./runner-routing.mts";

export function hasReadOnlyStatusInstallation(
	repository: string,
	installations: string,
): boolean {
	const owner = repository.split("/")[0]?.toLowerCase();
	if (!owner || !installations.trim()) return false;
	const matches: (string | undefined)[] = [];
	for (const line of installations.trim().split("\n")) {
		const value = asObject(parseJson(line));
		const installationOwner = asText(value?.owner);
		if (!installationOwner) return false;
		if (installationOwner.toLowerCase() === owner)
			matches.push(asText(value?.statuses));
	}
	return matches.length === 1 && matches[0] === "read";
}

export function githubAppStatusIsReadOnly(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
}): boolean {
	const host = input.env.GH_HOST?.toLowerCase();
	const token =
		host === "github.com" || host?.endsWith(".ghe.com")
			? (input.env.GH_TOKEN ?? input.env.GITHUB_TOKEN)
			: (input.env.GH_ENTERPRISE_TOKEN ?? input.env.GITHUB_ENTERPRISE_TOKEN);
	const repository = input.env.GH_REPO?.split("/").slice(-2).join("/");
	if (!token?.startsWith("ghu_") || !repository) return false;
	try {
		const installations = execFileSync(
			"gh",
			[
				"api",
				"user/installations?per_page=100",
				"--paginate",
				"--jq",
				".installations[] | {owner:.account.login, statuses:.permissions.statuses}",
			],
			{
				cwd: input.cwd,
				env: input.env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		return hasReadOnlyStatusInstallation(repository, installations);
	} catch {
		return false;
	}
}
