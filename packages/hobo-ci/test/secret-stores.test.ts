import type {
	BitwardenSdkClient,
	BitwardenSecret,
} from "@hobo/adapter-bitwarden";
import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { storeSettings } from "../src/ceremony-settings.js";
import { STORE_CHOICE } from "../src/owner-store.js";
import { openSecretStore } from "../src/secret-stores.js";

function signedIn(token = "machine-token") {
	const vault = createTrustedVault();
	vault.put("BWS_ACCESS_TOKEN", token);
	return vault;
}

const ORG = "11111111-2222-4333-8444-555555555555";
const PROJECT = "66666666-7777-4888-9999-aaaaaaaaaaaa";

describe("1Password through the owner's Connect server", () => {
	const coordinates = {
		OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
		OP_CONNECT_HOST: "https://connect.example",
	};

	it("stays closed until the owner hands this run a Connect token", async () => {
		let requests = 0;
		const opened = await openSecretStore(
			"1password",
			coordinates,
			createTrustedVault(),
			{
				fetch: async () => {
					requests += 1;
					return Response.json({}, { status: 401 });
				},
			},
		);
		expect(opened.ok).toBe(false);
		expect(requests).toBe(0);
	});

	it("sends only the handed-over token to the Connect server", async () => {
		const vault = createTrustedVault();
		vault.put("OP_CONNECT_TOKEN", "handed-over-connect-token");
		let authorization: string | null = null;
		const opened = await openSecretStore("1password", coordinates, vault, {
			fetch: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json([]);
			},
		});
		if (!opened.ok) throw new Error("not opened");
		await opened.store.port.access("NAME");
		expect(authorization).toBe("Bearer handed-over-connect-token");
	});
});

function fakeBitwarden(): BitwardenSdkClient {
	const secrets: BitwardenSecret[] = [];
	let revision = 0;
	const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++revision));
	return {
		secrets: () => ({
			list: async () => ({
				data: secrets.map(({ id, key, organizationId }) => ({
					id,
					key,
					organizationId,
				})),
			}),
			get: async (id) => {
				const found = secrets.find((secret) => secret.id === id);
				if (found === undefined) throw new Error("not found");
				return found;
			},
			create: async (organizationId, key, value, note, projectIds) => {
				const secret: BitwardenSecret = {
					id: `s${secrets.length + 1}`,
					key,
					value,
					note,
					organizationId,
					projectId: projectIds[0] ?? null,
					revisionDate: stamp(),
				};
				secrets.push(secret);
				return secret;
			},
			update: async (organizationId, id, key, value, note, projectIds) => {
				const index = secrets.findIndex((secret) => secret.id === id);
				const secret: BitwardenSecret = {
					id,
					key,
					value,
					note,
					organizationId,
					projectId: projectIds[0] ?? null,
					revisionDate: stamp(),
				};
				secrets[index] = secret;
				return secret;
			},
		}),
	};
}

describe("Bitwarden Secrets Manager", () => {
	it("is offered on the setup page, with its token never saved", () => {
		expect(STORE_CHOICE.field.options).toContainEqual(
			expect.objectContaining({ value: "bitwarden" }),
		);
		const fields = storeSettings("bitwarden", "/unused").map((s) => s.field);
		// The page asks only for the personal API key; the server URL and the
		// organization (if several) are optional; what the run provisions
		// (project, collection, device) never appears here.
		expect(fields.map((field) => field.name)).toEqual([
			"BWS_SERVER",
			"BITWARDEN_SERVER_URL",
			"BW_CLIENTID",
			"BW_CLIENTSECRET",
			"BWS_ORGANIZATION_ID",
		]);
		expect(fields.find((f) => f.name === "BW_CLIENTSECRET")?.kind).toBe(
			"secret",
		);
		for (const name of ["BITWARDEN_SERVER_URL", "BWS_ORGANIZATION_ID"])
			expect(fields.find((f) => f.name === name)?.required).toBe(false);
	});

	it("writes into the bound project and names entries by reference", async () => {
		let server = "";
		let token: string | undefined;
		const opened = await openSecretStore(
			"bitwarden",
			{ BWS_SERVER: "eu", BWS_ORGANIZATION_ID: ORG, BWS_PROJECT_ID: PROJECT },
			signedIn(),
			{
				bitwardenClient: async (coordinates, signIn) => {
					server = coordinates.BWS_SERVER ?? "";
					token = signIn.reveal("BWS_ACCESS_TOKEN");
					return fakeBitwarden();
				},
			},
		);
		// The token came from the run's vault; the cloud from the locator.
		expect(token).toBe("machine-token");
		expect(server).toBe("eu");
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		await opened.store.port.put("HOBO_CI_GITHUB_APP_ID", "42");
		await opened.store.port.put("HOBO_CI_GITHUB_APP_ID", "43");
		const read = await opened.store.port.access("HOBO_CI_GITHUB_APP_ID");
		expect(read.status).toBe("ok");
		expect(read.status === "ok" ? read.material : undefined).toBe("43");
		expect(opened.store.reference("HOBO_CI_GITHUB_APP_ID")).toBe(
			`bitwarden://${ORG}/${PROJECT}/HOBO_CI_GITHUB_APP_ID`,
		);
	});

	it("says what is missing instead of failing late", async () => {
		const unbound = await openSecretStore(
			"bitwarden",
			{},
			createTrustedVault(),
		);
		expect(unbound.ok).toBe(false);
		if (!unbound.ok)
			expect(unbound.remediation.join(" ")).toMatch(
				/organization and project IDs/,
			);
		const signedOut = await openSecretStore(
			"bitwarden",
			{ BWS_ORGANIZATION_ID: ORG, BWS_PROJECT_ID: PROJECT },
			createTrustedVault(),
			{
				bitwardenClient: async () => {
					throw new Error("bad token");
				},
			},
		);
		expect(signedOut.ok).toBe(false);
		if (!signedOut.ok)
			expect(signedOut.remediation.join(" ")).toMatch(/access token/);
	});
});
