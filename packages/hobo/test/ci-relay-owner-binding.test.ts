import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { readOwnerRelayBinding } from "../src/ci-relay-owner-binding.js";

const teamId = "team_example";
const projectId = "prj_example";
const privateValue = "fixture-private-project";
const binding = {
	kind: "infisical",
	siteUrl: "https://fixture.invalid",
	projectId: privateValue,
	environment: "prod",
	secretPath: "/fixture",
	identityId: "fixture-relay",
};
const record = () =>
	JSON.stringify({
		schema: "hobo.ci-relay-binding/v1",
		teamId,
		projectId,
		binding,
	});

describe("private relay runtime binding", () => {
	it.each([
		"infisical",
		"1password",
		"bitwarden",
	] as const)("reads the binding through an opened %s owner store", async (id) => {
		const store = createMemorySecretsPort();
		await store.put("HOBO_CI_RELAY_RUNTIME_BINDING", record());
		const result = await readOwnerRelayBinding({
			cwd: "/fixture",
			env: {},
			teamId,
			projectId,
			open: async () => ({
				chosen: true,
				opened: { id, port: store, reference: () => "fixture" },
			}),
		});
		expect(result.kind).toBe("ready");
		if (result.kind === "ready")
			expect(result.binding.projectId).toBe(privateValue);
	});

	it("refuses mismatched and invalid bindings without returning their contents", async () => {
		const store = createMemorySecretsPort();
		await store.put("HOBO_CI_RELAY_RUNTIME_BINDING", record());
		const input = {
			cwd: "/fixture",
			env: {},
			teamId,
			projectId: "prj_other",
			open: async () => ({
				chosen: true,
				opened: {
					id: "infisical" as const,
					port: store,
					reference: () => "fixture",
				},
			}),
		};
		expect(await readOwnerRelayBinding(input)).toEqual({ kind: "mismatch" });
		await store.put("HOBO_CI_RELAY_RUNTIME_BINDING", privateValue);
		const invalid = await readOwnerRelayBinding(input);
		expect(invalid).toEqual({ kind: "invalid" });
		expect(JSON.stringify(invalid)).not.toContain(privateValue);
	});

	it("rejects extra identities and insecure runtime origins", async () => {
		const store = createMemorySecretsPort();
		const input = {
			cwd: "/fixture",
			env: {},
			teamId,
			projectId,
			open: async () => ({
				chosen: true,
				opened: {
					id: "infisical" as const,
					port: store,
					reference: () => "fixture",
				},
			}),
		};
		for (const invalid of [
			{ ...binding, deployIdentityId: "fixture-writer" },
			{ ...binding, siteUrl: "http://localhost" },
			{ ...binding, identityId: "" },
		]) {
			await store.put(
				"HOBO_CI_RELAY_RUNTIME_BINDING",
				JSON.stringify({
					schema: "hobo.ci-relay-binding/v1",
					teamId,
					projectId,
					binding: invalid,
				}),
			);
			expect(await readOwnerRelayBinding(input)).toEqual({ kind: "invalid" });
		}
		await store.put(
			"HOBO_CI_RELAY_RUNTIME_BINDING",
			JSON.stringify({
				schema: "hobo.ci-relay-binding/v1",
				teamId,
				projectId,
				binding,
				otherIdentity: "fixture-private-identity",
			}),
		);
		expect(await readOwnerRelayBinding(input)).toEqual({ kind: "invalid" });
	});

	it("treats missing and inaccessible stores as incomplete setup without leaking errors", async () => {
		const vault = createTrustedVault();
		vault.put("INFISICAL_TOKEN", "fixture-token");
		const absent = await readOwnerRelayBinding({
			cwd: "/fixture",
			env: {},
			teamId,
			projectId,
			ownerSession: vault,
			open: async () => ({ chosen: false }),
		});
		expect(absent).toEqual({ kind: "missing" });
		const unavailable = await readOwnerRelayBinding({
			cwd: "/fixture",
			env: {},
			teamId,
			projectId,
			ownerSession: vault,
			open: async () => {
				throw new Error("fixture-token");
			},
		});
		expect(unavailable).toEqual({ kind: "unavailable" });
		expect(JSON.stringify(unavailable)).not.toContain("fixture-token");
	});

	it("refuses a binding if the owner changes selection while it is read", async () => {
		const store = createMemorySecretsPort();
		await store.put("HOBO_CI_RELAY_RUNTIME_BINDING", record());
		let reads = 0;
		const result = await readOwnerRelayBinding({
			cwd: "/fixture",
			env: {},
			teamId,
			projectId,
			ownerSettings: {
				read: async () => ({}),
				write: async () => {},
				assertCurrent: () => {
					reads += 1;
					if (reads > 1) throw new Error(privateValue);
				},
			},
			open: async () => ({
				chosen: true,
				opened: { id: "infisical", port: store, reference: () => "fixture" },
			}),
		});
		expect(result).toEqual({ kind: "unavailable" });
		expect(JSON.stringify(result)).not.toContain(privateValue);
	});
});
