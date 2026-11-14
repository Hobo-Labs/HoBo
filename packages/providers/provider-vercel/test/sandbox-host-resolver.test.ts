import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { VercelResolverOptions } from "../src/resolvers.js";
import {
	createVercelSandboxHostResolver,
	preflightVercelSandboxHost,
	VERCEL_SANDBOX_HOST_PRODUCT_ID,
	type VercelSandboxHostProof,
	type VercelSandboxHostScope,
} from "../src/sandbox-host-resolver.js";

const scope: VercelSandboxHostScope = {
	teamId: "team_123",
	projectId: "prj_123",
	organization: "Hobo-Labs",
	repository: "HoBo",
	revision: "0123456789abcdef0123456789abcdef01234567",
	environment: "production",
	minimumSlots: 2,
	workload: {
		guestDurationMs: 600000,
		proxyDurationMs: 660000,
		guestVcpus: 2,
		guestMemoryMb: 2048,
		proxyVcpus: 1,
		proxyMemoryMb: 1024,
		guestNetworkBytes: 500000,
		proxyNetworkBytes: 600000,
		maxControlCalls: 25,
	},
};
const request: ResolveRequest = {
	ref: {
		slot: "service",
		productId: VERCEL_SANDBOX_HOST_PRODUCT_ID,
		logicalId: "runner",
	},
	desired: { ...scope, workload: { ...scope.workload } },
	credentialRef: "vault://vercel/team",
};
const proof: VercelSandboxHostProof = {
	scope,
	workloadIdentityVerified: true,
	createAuthorized: true,
	availableSlots: 2,
	quote: {
		currency: "USD",
		totalMicros: 1234,
		includesComputeAndMemory: true,
		includesNetwork: true,
		includesFixedCosts: true,
		includesAllowances: true,
	},
	observedAtMs: 1000000,
	expiresAtMs: 1100000,
	evidenceRef: "evidence/sandbox-123",
};
function fixture(
	changes: {
		project?: object;
		status?: number;
		evidence?: VercelSandboxHostProof;
	} = {},
) {
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		if (url.hostname === "api.vercel.com")
			return {
				status: changes.status ?? 200,
				headers: {},
				body: JSON.stringify(
					changes.project ?? {
						id: scope.projectId,
						accountId: scope.teamId,
						link: {
							type: "github",
							org: scope.organization,
							repo: scope.repository,
						},
					},
				),
			};
		return {
			status: 200,
			headers: {},
			body: JSON.stringify({ sandboxes: [] }),
		};
	};
	const evidence = changes.evidence;
	const options: VercelResolverOptions = {
		teamId: scope.teamId,
		resolveCredential: async () => "provider-private-token",
		sandboxNowMs: () => 1010000,
		...(evidence ? { verifySandboxHost: async () => evidence } : undefined),
	};
	return { transport, calls, options };
}

describe("Vercel Sandbox execution host", () => {
	it("leaves creation permission, runtime identity, capacity and price unobserved after a successful read-only listing", async () => {
		const f = fixture();
		expect(
			await preflightVercelSandboxHost(
				{ ...scope, credentialRef: request.credentialRef },
				f.options,
				f.transport,
			),
		).toMatchObject({
			projectLink: "linked",
			sandboxRead: "verified",
			workloadIdentity: "not-observed",
			createAuthorization: "not-observed",
			capacity: "not-observed",
		});
		expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
		expect(new URL(f.calls[1]?.url ?? "").pathname).toBe("/api/v2/sandboxes");
		await expect(
			createVercelSandboxHostResolver(f.options).reconcile(
				request,
				f.transport,
			),
		).rejects.toThrow(/fresh workload/u);
	});
	it("adopts only exact scope with a fresh complete proof, and reuses the native project identity", async () => {
		const f = fixture({ evidence: proof });
		const resolver = createVercelSandboxHostResolver(f.options);
		expect(await resolver.reconcile(request, f.transport)).toMatchObject({
			action: "adopt",
			physicalId: scope.projectId,
			outputs: { quoteMicros: 1234, minimumSlots: 2 },
		});
		expect(
			await resolver.reconcile(
				{ ...request, ref: { ...request.ref, physicalId: scope.projectId } },
				f.transport,
			),
		).toMatchObject({ action: "noop" });
		expect(await resolver.read?.(request, f.transport)).toMatchObject({
			action: "noop",
		});
		expect(
			JSON.stringify(f.calls.map(({ method, url }) => ({ method, url }))),
		).not.toContain("provider-private-token");
	});
	it.each([
		{ ...proof, scope: { ...scope, revision: "f".repeat(40) } },
		{
			...proof,
			scope: { ...scope, workload: { ...scope.workload, guestDurationMs: 1 } },
		},
		{ ...proof, availableSlots: 1 },
		{ ...proof, observedAtMs: 1 },
		{ ...proof, expiresAtMs: 1000001 },
		{ ...proof, quote: { ...proof.quote, includesNetwork: false } },
		{ ...proof, createAuthorized: false },
	])("rejects insufficient, stale or incorrectly scoped proof %#", async (bad) => {
		// SAFETY: this deliberately malformed fixture exercises the runtime proof validator.
		const f = fixture({ evidence: bad as VercelSandboxHostProof });
		await expect(
			createVercelSandboxHostResolver(f.options).reconcile(
				request,
				f.transport,
			),
		).rejects.toThrow(/incomplete, expired or does not match/u);
	});
	it("reports an unlinked project as a repairable plan but does not adopt it prematurely", async () => {
		const f = fixture({
			project: { id: scope.projectId, accountId: scope.teamId, link: null },
			evidence: proof,
		});
		expect(
			await preflightVercelSandboxHost(
				{ ...scope, credentialRef: request.credentialRef },
				f.options,
				f.transport,
			),
		).toMatchObject({
			projectLink: "requires-link",
			gitLinkAuthorization: "not-observed",
		});
		await expect(
			createVercelSandboxHostResolver(f.options).reconcile(
				request,
				f.transport,
			),
		).rejects.toThrow(/linked project/u);
		const authorized = fixture({
			project: { id: scope.projectId, accountId: scope.teamId, link: null },
			evidence: {
				...proof,
				gitLinkAuthorization: {
					authorized: true,
					observedAtMs: 1000000,
					expiresAtMs: 1050000,
					evidenceRef: "provider/link-proof",
				},
			},
		});
		expect(
			await preflightVercelSandboxHost(
				{ ...scope, credentialRef: request.credentialRef },
				authorized.options,
				authorized.transport,
			),
		).toMatchObject({
			projectLink: "requires-link",
			gitLinkAuthorization: "verified",
			expiresAtMs: 1050000,
		});
		const expired = fixture({
			project: { id: scope.projectId, accountId: scope.teamId, link: null },
			evidence: {
				...proof,
				gitLinkAuthorization: {
					authorized: true,
					observedAtMs: 1000000,
					expiresAtMs: 1000001,
					evidenceRef: "provider/link-proof",
				},
			},
		});
		await expect(
			preflightVercelSandboxHost(
				{ ...scope, credentialRef: request.credentialRef },
				expired.options,
				expired.transport,
			),
		).rejects.toThrow(/authorization evidence/u);
	});
	it("rejects a foreign project, mismatched repository, or insufficient proxy capacity", async () => {
		for (const project of [
			{ id: scope.projectId, accountId: "team_other" },
			{
				id: scope.projectId,
				accountId: scope.teamId,
				link: { type: "github", org: "other", repo: scope.repository },
			},
		]) {
			const f = fixture({ project, evidence: proof });
			await expect(
				createVercelSandboxHostResolver(f.options).reconcile(
					request,
					f.transport,
				),
			).rejects.toThrow();
		}
		const f = fixture({ evidence: proof });
		await expect(
			createVercelSandboxHostResolver(f.options).reconcile(
				{ ...request, desired: { ...request.desired, minimumSlots: 1 } },
				f.transport,
			),
		).rejects.toThrow();
		await expect(
			createVercelSandboxHostResolver(f.options).reconcile(
				{
					...request,
					desired: {
						...request.desired,
						workload: { ...scope.workload, unspecifiedCost: 1 },
					},
				},
				f.transport,
			),
		).rejects.toThrow(/unsupported fields/u);
	});
	it("requires verified drain and an admission fence before detachment", async () => {
		const f = fixture({ evidence: proof });
		const known = {
			...request,
			ref: { ...request.ref, physicalId: scope.projectId },
		};
		await expect(
			createVercelSandboxHostResolver(f.options).delete(known, f.transport),
		).rejects.toThrow(/admission fence/u);
		await expect(
			createVercelSandboxHostResolver({
				...f.options,
				retireSandboxHost: async () => ({
					drained: true,
					fencedUntilDetached: false,
					evidenceRef: "fence/1",
				}),
			}).delete(known, f.transport),
		).rejects.toThrow(/admission fence/u);
		await expect(
			createVercelSandboxHostResolver({
				...f.options,
				retireSandboxHost: async () => ({
					drained: true,
					fencedUntilDetached: true,
					evidenceRef: "fence/1",
				}),
			}).delete(known, f.transport),
		).resolves.toBeUndefined();
		expect(f.calls).toHaveLength(0);
	});
});
