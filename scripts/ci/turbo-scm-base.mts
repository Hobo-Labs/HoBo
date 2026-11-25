import process from "node:process";

const event = process.env.GITHUB_EVENT_NAME ?? "";
const baseRef = process.env.GITHUB_BASE_REF ?? "main";

if (event === "merge_group") {
	const sha = process.env.GITHUB_EVENT_MERGE_GROUP_BASE_SHA?.trim();
	if (!sha) {
		console.error(
			"turbo-scm-base: missing GITHUB_EVENT_MERGE_GROUP_BASE_SHA for merge_group",
		);
		process.exit(1);
	}
	process.stdout.write(sha);
} else if (event === "pull_request") {
	process.stdout.write(`origin/${baseRef}`);
} else {
	process.stdout.write("origin/main");
}
