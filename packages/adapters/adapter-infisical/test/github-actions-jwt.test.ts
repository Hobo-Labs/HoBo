import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { githubActionsJwtSource, jwtOidcClaimHints } from "../src/index.js";
import { fakeJwt } from "./support/fake-infisical.js";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function tokenService(answer: (url: string, auth: string) => JsonValue) {
	const seen: { url: string; auth: string }[] = [];
	const server = createServer((request, response) => {
		const auth = request.headers.authorization ?? "";
		seen.push({ url: request.url ?? "", auth });
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(answer(request.url ?? "", auth)));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => {
		server.closeAllConnections();
		server.close();
	});
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/token?api-version=2.0`, seen };
}

describe("githubActionsJwtSource", () => {
	it("requests the job's token with the runner's bearer and audience", async () => {
		const jwt = fakeJwt("repo:Hobo-Labs/HoBo:ref:refs/heads/main");
		const service = await tokenService(() => ({ value: jwt }));
		const source = githubActionsJwtSource({
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL: service.url,
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
			},
			audience: "https://github.com/Hobo-Labs",
		});
		expect(await source()).toBe(jwt);
		expect(service.seen[0]).toEqual({
			url: "/token?api-version=2.0&audience=https%3A%2F%2Fgithub.com%2FHobo-Labs",
			auth: "bearer runner-request-token",
		});
	});

	it("fails without the job's id-token permission, without echoing anything", async () => {
		await expect(githubActionsJwtSource({ env: {} })()).rejects.toMatchObject({
			code: "jwt-unavailable",
		});
		const service = await tokenService(() => ({ value: "not-a-jwt" }));
		await expect(
			githubActionsJwtSource({
				env: {
					ACTIONS_ID_TOKEN_REQUEST_URL: service.url,
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
				},
			})(),
		).rejects.toThrow(
			/^infisical workload identity token failed: jwt-unavailable$/u,
		);
	});
});

describe("jwtOidcClaimHints", () => {
	it("returns sub and aud without echoing the JWT", () => {
		const jwt = fakeJwt("repo:Hobo-Labs/HoBo:ref:refs/heads/main");
		expect(jwtOidcClaimHints(jwt)).toEqual({
			sub: "repo:Hobo-Labs/HoBo:ref:refs/heads/main",
		});
	});
});
