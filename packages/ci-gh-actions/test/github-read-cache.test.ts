import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { withGithubReadCache } from "../src/github-read-cache.js";

describe("GitHub read cache", () => {
	it("serves cached run jobs and uses If-None-Match on refresh", async () => {
		const request = vi.fn<GithubTransport["request"]>();
		const body = JSON.stringify({
			jobs: [
				{
					id: 1,
					run_id: 99,
					status: "queued",
					labels: ["hobo"],
					runner_name: null,
					runner_id: null,
				},
			],
		});
		request
			.mockResolvedValueOnce(
				new Response(body, {
					status: 200,
					headers: { etag: 'W/"first"' },
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));

		const api = withGithubReadCache({ request }, 30_000);
		const path =
			"/repos/Hobo-Labs/HoBo/actions/runs/99/jobs?filter=latest&per_page=100";
		const first = await api.request(1, path);
		const second = await api.request(1, path);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(await first.text()).toBe(body);
		expect(await second.text()).toBe(body);
		expect(request).toHaveBeenCalledOnce();
	});

	it("does not cache non-GET or unrelated paths", async () => {
		const request = vi.fn<GithubTransport["request"]>(async () =>
			new Response("{}", { status: 200 }),
		);
		const api = withGithubReadCache({ request });
		await api.request(1, "/repos/a/b", "POST", "{}");
		await api.request(1, "/repos/a/b");
		await api.request(1, "/repos/a/b");
		expect(request).toHaveBeenCalledTimes(3);
	});
});
