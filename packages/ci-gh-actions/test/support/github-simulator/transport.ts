import type { GithubTransport } from "../../../src/github.js";
import type { GithubSimulator } from "./simulator.js";

export function simulatorTransport(sim: GithubSimulator): GithubTransport {
	return {
		request: (_installationId, path, method = "GET", body, ifNoneMatch) => {
			const headers = new Headers({
				authorization: "Bearer simulator-installation-token",
				accept: "application/vnd.github+json",
			});
			if (ifNoneMatch !== undefined) headers.set("if-none-match", ifNoneMatch);
			return sim.fetch(`${sim.baseUrl}${path}`, {
				method,
				headers,
				body: body ?? null,
			});
		},
	};
}
