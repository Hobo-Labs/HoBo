import { spawnSync } from "node:child_process";

function capture(command: string, args: string[]) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) return "";
	return result.stdout.trim();
}

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	return result.status ?? 1;
}

function stripRef(value: string) {
	return value
		.replace(/^refs\/heads\//, "")
		.replace(/^origin\//, "")
		.trim();
}

function firstRemote() {
	return capture("git", ["remote"]).split(/\r?\n/).filter(Boolean)[0] ?? "";
}

function defaultBranch(remote: string) {
	const ref = capture("git", [
		"symbolic-ref",
		"--quiet",
		`refs/remotes/${remote}/HEAD`,
	]);
	if (ref) return stripRef(ref.replace(`refs/remotes/${remote}/`, ""));
	return "main";
}

function ghBaseRef() {
	const json = capture("gh", [
		"pr",
		"view",
		"--json",
		"baseRefName",
		"--jq",
		".baseRefName",
	]);
	return json ? stripRef(json) : "";
}

const remote =
	process.env.HOBO_PR_REMOTE ||
	(capture("git", ["remote", "get-url", "origin"]) ? "origin" : firstRemote());
if (!remote) {
	console.error(
		"No git remote found; using origin/main without fetching. Configure origin or set HOBO_PR_REMOTE to enable PR-base refresh.",
	);
	console.log("origin/main");
	process.exit(0);
}

const base = stripRef(
	process.env.HOBO_PR_BASE ||
		process.env.GITHUB_BASE_REF ||
		process.env.CHANGE_TARGET ||
		process.env.SYSTEM_PULLREQUEST_TARGETBRANCH ||
		ghBaseRef() ||
		defaultBranch(remote),
);

if (!base) {
	console.error(
		"No PR/base branch found; using origin/main. Set HOBO_PR_BASE, GITHUB_BASE_REF, or CHANGE_TARGET to override.",
	);
	console.log("origin/main");
	process.exit(0);
}

console.error(`Fetching ${remote}/${base} for targeted checks...`);
const status = run("git", [
	"fetch",
	"--no-tags",
	remote,
	`+refs/heads/${base}:refs/remotes/${remote}/${base}`,
]);
if (status !== 0) process.exit(status);
console.log(`${remote}/${base}`);
