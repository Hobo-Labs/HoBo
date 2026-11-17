import type { GithubTransport } from "../src/github.js";

const JIT_RUNNER_DELETE = /^\/repos\/[^/]+\/[^/]+\/actions\/runners\/\d+$/u;

/** Accept JIT runner DELETE without implementing the rest of the GitHub API. */
export function jitRunnerDeregisterGithub(
	inner?: GithubTransport,
): GithubTransport {
	const base: GithubTransport =
		inner ??
		({
			async request() {
				throw new Error("unexpected GitHub request");
			},
		} satisfies GithubTransport);
	return {
		async request(installationId, path, method, body, ifNoneMatch) {
			if (method === "DELETE" && JIT_RUNNER_DELETE.test(path))
				return new Response(null, { status: 204 });
			return base.request(installationId, path, method, body, ifNoneMatch);
		},
	};
}

/** A complete empty assignment scan for tests that exercise unrelated cleanup. */
export function jitRunnerGithubWithoutAssignments(): GithubTransport {
	return jitRunnerDeregisterGithub({
		async request(_installationId, path) {
			if (path.includes("/actions/runs?status=in_progress&")) {
				return Response.json({ workflow_runs: [] });
			}
			if (
				path.includes("/actions/runs/") &&
				path.includes("/jobs?filter=latest&")
			) {
				return Response.json({ jobs: [] });
			}
			throw new Error(`unexpected GitHub request ${path}`);
		},
	});
}
