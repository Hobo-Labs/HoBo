import { create } from "@bufbuild/protobuf";
import { RepositorySetupRequestSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import { prepareIsolatedConnection } from "../src/isolated-onboarding.js";

function setup() {
	const principal = {
		accountId: "account-a",
		installationIds: [10],
		scopes: ["repositories:write"],
	};
	const input = create(RepositorySetupRequestSchema, {
		repository: "owner/repo",
		repositoryId: 101,
		installationId: 10,
		trustedRepositoryAcknowledged: true,
		publicRepositoryAcknowledged: true,
		acceptAllMatchingRepositoryJobs: true,
	});
	const github = {
		appRequest: vi.fn(async (path: string) => {
			if (path === "/app") return Response.json({ id: 42 });
			if (path === "/app/installations/10")
				return Response.json({
					id: 10,
					app_id: 42,
					suspended_at: null,
					permissions: {
						actions: "write",
						administration: "write",
						metadata: "read",
					},
				});
			if (path === "/repos/owner/repo/installation")
				return Response.json({ id: 10, app_id: 42 });
			return new Response(null, { status: 404 });
		}),
		request: vi.fn(async () =>
			Response.json({
				id: 101,
				full_name: "owner/repo",
				private: false,
				default_branch: "main",
			}),
		),
	};
	return { principal, input, github, isolatedHostAvailable: true };
}

describe("isolated repository onboarding", () => {
	it("connects a verified public repository without bridge metadata", async () => {
		const options = setup();
		const connection = await prepareIsolatedConnection(options);
		expect(connection.isolatedOnly).toBe(true);
		expect(connection.bridgeWorkflow).toBe("");
		expect(connection.bridgeSha).toBe("");
		expect(connection.bridgeRef).toBe("");
		expect(connection.dispatcherActorId).toBe(0);
		expect(connection.allowedRefs).toEqual([]);
		expect(connection.allowedEvents).toEqual([]);
		expect(connection.acceptAllMatchingRepositoryJobs).toBe(true);
		expect(options.github.request).toHaveBeenCalledTimes(1);
	});
	it("fails before provider calls without an attested isolated host", async () => {
		const options = setup();
		options.isolatedHostAvailable = false;
		await expect(prepareIsolatedConnection(options)).rejects.toThrow(
			"isolated runner host is unavailable",
		);
		expect(options.github.appRequest).not.toHaveBeenCalled();
	});
	it("rejects an installation outside the account", async () => {
		const options = setup();
		options.principal.installationIds = [11];
		await expect(prepareIsolatedConnection(options)).rejects.toThrow(
			"installation is not bound",
		);
		expect(options.github.appRequest).not.toHaveBeenCalled();
	});
	it("requires explicit public-repository acknowledgment even for a private repository", async () => {
		const options = setup();
		options.input.publicRepositoryAcknowledged = false;
		await expect(prepareIsolatedConnection(options)).rejects.toThrow(
			"invalid repository setup request",
		);
	});
	it("rejects a different repository identity or revoked runner permission", async () => {
		const first = setup();
		first.input.repositoryId = 999;
		await expect(prepareIsolatedConnection(first)).rejects.toThrow(
			"repository identity changed",
		);
		const second = setup();
		second.github.appRequest.mockImplementation(async (path) =>
			path === "/app"
				? Response.json({ id: 42 })
				: Response.json({
						id: 10,
						app_id: 42,
						suspended_at: null,
						permissions: {
							actions: "write",
							administration: "read",
							metadata: "read",
						},
					}),
		);
		await expect(prepareIsolatedConnection(second)).rejects.toThrow(
			"lacks runner permissions",
		);
	});
	it("rejects missing universal consent and branch or PR restrictions", async () => {
		const first = setup();
		first.input.acceptAllMatchingRepositoryJobs = false;
		await expect(prepareIsolatedConnection(first)).rejects.toThrow(
			"invalid repository setup request",
		);
		const second = setup();
		second.input.allowedRefs = ["refs/heads/main"];
		await expect(prepareIsolatedConnection(second)).rejects.toThrow(
			"invalid repository setup request",
		);
		const third = setup();
		third.input.allowAllPullRequests = true;
		await expect(prepareIsolatedConnection(third)).rejects.toThrow(
			"invalid repository setup request",
		);
	});
});
