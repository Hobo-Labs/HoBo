import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	bootstrapInfisicalInstance,
	createInfisicalAdmin,
	InfisicalError,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const ADMIN_TOKEN = "fixture-instance-admin-token";
const PASSWORD = "fixture-bootstrap-password-0123456789";
// GitHub's immutable subject (owner and repository suffixed with their ids),
// with the ids pinned again as claims that hold whatever the subject format.
const DEPLOY_TRUST = {
	issuer: "https://token.actions.githubusercontent.com",
	audiences: ["https://github.com/Hobo-Labs"],
	subject: "repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main",
	claims: {
		repository_id: "1274791462",
		repository_owner_id: "344805935",
	},
};

let pact: PactDocument;
let url: string;
let close: () => void;
const seen: { request: PactRequest; matched: boolean }[] = [];

beforeAll(async () => {
	const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
	const found = pacts.find((p) => p.provider.name === "InfisicalAdminApi");
	if (!found) throw new Error("the Infisical admin pact is missing");
	pact = found;
	const mock = createMockProviderFromPact(pact);
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", async () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const headers: Record<string, string> = {};
			for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2)
				headers[(incoming.rawHeaders[i] ?? "").toLowerCase()] =
					incoming.rawHeaders[i + 1] ?? "";
			const method = METHODS.find((candidate) => candidate === incoming.method);
			if (method === undefined) {
				outgoing.writeHead(405).end();
				return;
			}
			const request: PactRequest = raw
				? { method, path: incoming.url ?? "/", headers, body: JSON.parse(raw) }
				: { method, path: incoming.url ?? "/", headers };
			const response = await mock.handle(request);
			seen.push({
				request,
				matched: !JSON.stringify(response.body ?? "").includes(
					"PACT_NO_INTERACTION",
				),
			});
			outgoing.writeHead(response.status, response.headers);
			outgoing.end(
				response.body === undefined ? "" : JSON.stringify(response.body),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const address = server.address() as AddressInfo;
	url = `http://127.0.0.1:${address.port}`;
	close = () => {
		server.closeAllConnections();
		server.close();
	};
});

afterAll(() => close());

/** Every request made is one the pact records, with the headers it names. */
function expectRecorded() {
	for (const { request, matched } of seen) {
		expect(matched, `${request.method} ${request.path}`).toBe(true);
		const interaction = pact.interactions.find(
			(candidate) =>
				candidate.request.method === request.method &&
				candidate.request.path === request.path,
		);
		for (const [name, value] of Object.entries(
			interaction?.request.headers ?? {},
		))
			expect(request.headers?.[name], `${request.path} ${name}`).toBe(value);
	}
	seen.length = 0;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InfisicalError) {
			// No error carries the token or the password.
			expect(error.message).not.toContain(ADMIN_TOKEN);
			expect(error.message).not.toContain(PASSWORD);
			return error.code;
		}
		throw error;
	}
	return "ok";
}

describe("Infisical's admin API (consumer contract)", () => {
	it("names the provisioner as consumer", () => {
		expect(pact.consumer.name).toBe("HoboInfisicalProvisioner");
	});

	it("bootstraps a fresh instance once, and is refused a second time", async () => {
		const instance = await bootstrapInfisicalInstance({
			siteUrl: url,
			email: "owner@hobo.invalid",
			password: PASSWORD,
			organization: "hobo",
		});
		expect(instance).toEqual({
			organizationId: "org-1",
			adminUserId: "user-1",
			adminEmail: "owner@hobo.invalid",
			instanceAdminIdentityId: "bootstrap-identity",
			instanceAdminToken: ADMIN_TOKEN,
		});
		expect(
			await codeOf(
				bootstrapInfisicalInstance({
					siteUrl: url,
					email: "owner@hobo.invalid",
					password: PASSWORD,
					organization: "already-bootstrapped",
				}),
			),
		).toBe("rejected");
		expectRecorded();
	});

	it("refuses a short password before any request", async () => {
		expect(
			await codeOf(
				bootstrapInfisicalInstance({
					siteUrl: url,
					email: "owner@hobo.invalid",
					password: "short",
					organization: "hobo",
				}),
			),
		).toBe("invalid-input");
		expect(seen).toHaveLength(0);
	});

	it("makes the relay's project, folder, identities and OIDC trust", async () => {
		const admin = createInfisicalAdmin({
			siteUrl: url,
			accessToken: ADMIN_TOKEN,
		});
		const { projectId } = await admin.createProject({
			name: "hobo-ci",
			slug: "hobo-ci",
		});
		expect(projectId).toBe("proj-1");
		expect(
			await admin.createFolder({
				projectId,
				environment: "prod",
				name: "hobo-ci-relay",
			}),
		).toEqual({ folderId: "folder-1" });
		const relay = await admin.createProjectIdentity({
			projectId,
			name: "hobo-ci-relay",
			role: "viewer",
		});
		const deployProject = await admin.createProject({
			name: "hobo-ci-deploy",
			slug: "hobo-ci-deploy",
		});
		expect(deployProject.projectId).toBe("proj-2");
		const deploy = await admin.createProjectIdentity({
			projectId: deployProject.projectId,
			name: "hobo-ci-deploy",
			role: "viewer",
		});
		expect([relay.identityId, deploy.identityId]).toEqual([
			"relay-identity",
			"deploy-identity",
		]);
		await admin.attachOidcAuth(relay.identityId, {
			issuer: "https://oidc.vercel.com/hobo-team",
			audiences: ["https://vercel.com/hobo-team"],
			subject: "owner:hobo-team:project:hobo-ci:environment:production",
			claims: { owner_id: "team_fixture", project_id: "prj_fixture" },
		});
		await admin.attachOidcAuth(deploy.identityId, DEPLOY_TRUST);
		expectRecorded();
	});

	it("replaces an existing deploy identity's OIDC trust in place, and names an identity without one", async () => {
		const admin = createInfisicalAdmin({
			siteUrl: url,
			accessToken: ADMIN_TOKEN,
		});
		await admin.updateOidcAuth("deploy-identity", DEPLOY_TRUST);
		expect(
			await codeOf(admin.updateOidcAuth("no-oidc-identity", DEPLOY_TRUST)),
		).toBe("not-found");
		// Repair only: no identity or project is created on the way.
		expect(seen.map(({ request }) => request.method)).toEqual([
			"PATCH",
			"PATCH",
		]);
		expectRecorded();
	});

	it("maps a 403", async () => {
		const admin = createInfisicalAdmin({
			siteUrl: url,
			accessToken: ADMIN_TOKEN,
		});
		expect(
			await codeOf(admin.createProject({ name: "denied", slug: "denied" })),
		).toBe("forbidden");
		expectRecorded();
	});

	it("deletes the bootstrap identity and observes its token refused", async () => {
		const admin = createInfisicalAdmin({
			siteUrl: url,
			accessToken: ADMIN_TOKEN,
		});
		expect(await admin.probeToken("relay-identity")).toBe("valid");
		await admin.deleteIdentity("bootstrap-identity");
		expect(await admin.probeToken("bootstrap-identity")).toBe("revoked");
		expectRecorded();
	});

	it("keeps tokens and passwords out of every path", () => {
		for (const interaction of pact.interactions)
			expect(interaction.request.path).not.toMatch(/token|password|Bearer/iu);
	});
});
