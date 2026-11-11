import type { GithubTransport } from "../src/github.js";

const JIT_RUNNER_DELETE =
	/^\/repos\/[^/]+\/[^/]+\/actions\/runners\/\d+$/u;

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
