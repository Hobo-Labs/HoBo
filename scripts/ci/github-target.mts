/** Resolve the gh target and base remote to one repository before using evidence. */
import { execFileSync } from "node:child_process";
import { asObject, asText, parseJson } from "./runner-routing.mts";

type GithubRepository = Readonly<{ name: string; host: string }>;

function githubRepository(text: string): GithubRepository {
	const value = asObject(parseJson(text));
	const name = asText(value?.nameWithOwner);
	const url = asText(value?.url);
	if (!name || !url) throw new Error("invalid repository identity");
	const parsed = new URL(url);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(name) ||
		parsed.pathname.replace(/^\//u, "").replace(/\/$/u, "").toLowerCase() !==
			name.toLowerCase()
	)
		throw new Error("invalid repository URL");
	return { name, host: parsed.host.toLowerCase() };
}

/** Never pass embedded Git credentials to gh. */
function remoteWithoutCredentials(remote: string): string {
	if (/^[^/\s]*@[^/\s]*:/u.test(remote)) {
		const scp = /^[^@\s]+@([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/u.exec(remote);
		if (!scp) throw new Error("invalid scp-style remote");
		const host = scp[1] ?? "";
		const path = (scp[2] ?? "").replace(/^\/+|[?#].*$/gu, "");
		return `https://${host}/${path}`;
	}
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(remote)) return remote;
	const url = new URL(remote);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** The caller supplies an environment with Git location overrides removed. */
export function trustedGithubTarget(input: {
	cwd: string;
	remoteUrl: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}) {
	const environment = { ...input.env };
	const gh = (args: readonly string[]) =>
		execFileSync("gh", args, {
			cwd: input.cwd,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: input.timeoutMs ?? 5000,
			maxBuffer: 1024 * 1024,
		}).trim();
	const selected = githubRepository(
		gh(["repo", "view", "--json", "nameWithOwner,url"]),
	);
	const base = githubRepository(
		gh([
			"repo",
			"view",
			"--json",
			"nameWithOwner,url",
			"--",
			remoteWithoutCredentials(input.remoteUrl),
		]),
	);
	const requested = environment.GH_REPO?.split("/");
	const requestedName = requested?.slice(-2).join("/");
	const requestedHost = requested?.length === 3 ? requested[0] : undefined;
	if (
		selected.host !== base.host ||
		selected.name.toLowerCase() !== base.name.toLowerCase() ||
		(environment.GH_HOST &&
			environment.GH_HOST.toLowerCase() !== selected.host) ||
		(requested &&
			(requested.length < 2 ||
				requested.length > 3 ||
				requestedName?.toLowerCase() !== selected.name.toLowerCase() ||
				(requestedHost && requestedHost.toLowerCase() !== selected.host)))
	)
		throw new Error("selected repository differs from the base remote");
	environment.GH_HOST = selected.host;
	environment.GH_REPO = `${selected.host}/${selected.name}`;
	return { repository: selected.name, environment };
}
