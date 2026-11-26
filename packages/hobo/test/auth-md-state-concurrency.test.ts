import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	markAuthMdInfrastructureClaim,
	recordAuthMdDeployment,
} from "../src/auth-md-command.js";
import type { PresentedCredential } from "../src/credential-presenter.js";

it("preserves simultaneous deployment bindings and ownership rotation gates", async () => {
	const home = await mkdtemp(join(tmpdir(), "hobo-authmd-concurrent-"));
	const resource = "https://broker.example/";
	const registrationRef = "agent-one";
	const binding = {
		sessionId: "session-a",
		tenantId: "tenant-a",
		projectId: "project-a",
		audience: "broker-api",
		service: resource,
	};
	const state = {
		schemaVersion: "hobo.cli-authmd/v1",
		resource,
		registrationRef,
		binding,
		preClaimScopes: ["deploy:write"],
		privateKey: "unexchanged-test-key",
		issuedAt: new Date().toISOString(),
		principal: {
			registrationRef,
			phase: "human-bound",
			humanSubject: "human-owner",
			binding,
			preClaimScopes: ["deploy:write"],
			postClaimScopes: ["deploy:write"],
			claimedAt: new Date().toISOString(),
			rotateAfterInfrastructureClaim: true,
			rotationSatisfied: true,
		},
	};
	const registrations = join(home, "auth-md", "registrations");
	await mkdir(registrations, { recursive: true, mode: 0o700 });
	const file = join(
		registrations,
		`${createHash("sha256")
			.update(JSON.stringify([resource, registrationRef]))
			.digest("hex")}.json`,
	);
	await writeFile(file, JSON.stringify(state), { mode: 0o600 });
	const credential: PresentedCredential = {
		scheme: "bearer-session",
		principal: { kind: "agent", id: registrationRef },
		tenant: binding.tenantId,
		audience: binding.audience,
		accessToken: "not-exchanged",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		metadata: { protocol: "auth.md", resource },
	};
	try {
		const deployments = ["deployment-a", "deployment-b", "deployment-c"];
		await Promise.all(
			deployments.map((id) => recordAuthMdDeployment(home, credential, id)),
		);
		await Promise.all(
			deployments.map((id) =>
				markAuthMdInfrastructureClaim(home, resource, id),
			),
		);
		const stored = JSON.parse(await readFile(file, "utf8"));
		expect(stored.deployments.sort()).toEqual(deployments);
		expect(stored.ownedDeployments.sort()).toEqual(deployments);
		expect(stored.binding).toEqual(binding);
		expect(stored.principal.rotationSatisfied).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
