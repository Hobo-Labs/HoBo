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

function ghSignInKind(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
}): string | undefined {
	const host = input.env.GH_HOST?.toLowerCase() || "github.com";
	try {
		return execFileSync("gh", ["auth", "token", "--hostname", host], {
			cwd: input.cwd,
			env: input.env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			maxBuffer: 64 * 1024,
		})
			.trim()
			.slice(0, 4);
	} catch {
		return undefined;
	}
}

export function githubAppStatusIsReadOnly(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
}): boolean {
	const repository = input.env.GH_REPO?.split("/").slice(-2).join("/");
	if (!repository || ghSignInKind(input) !== "ghu_") return false;
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
