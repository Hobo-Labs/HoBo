import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	connectionAuthorize,
	connectionCreate,
	createManagementContext,
	projectCredentialAudit,
	projectDeploymentView,
	stationInit,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps) rmSync(d, { recursive: true, force: true });
	temps.length = 0;
});

function tempHome(): string {
	const d = mkdtempSync(join(tmpdir(), "hobo-mgmt-cloud-"));
	temps.push(d);
	return d;
}

const actor = { kind: "user", id: "user:test" } as const;

async function seedYardStore(home: string, yard: string): Promise<void> {
	const dataDir = join(home, "yards", yard);
	mkdirSync(dataDir, { recursive: true });
	const store = createRuntimeLocalEventStore({ dataDir });
	try {
		await store.append(
			"deployment:dep-1",
			[
				{
					type: "deployment.Requested",
					data: { deploymentId: "dep-1", bindleHash: "sha256:abc" },
				},
				{
					type: "resource.Provisioning",
					data: { deploymentId: "dep-1", resourceId: "web" },
				},
				{
					type: "resource.Provisioned",
					data: { deploymentId: "dep-1", resourceId: "web" },
				},
				{
					type: "deployment.Deployed",
					data: { deploymentId: "dep-1" },
				},
				{
					type: "token.Granted",
					data: {
						correlationId: "corr-dep-1",
						grantId: "grant-1",
						svidSubject: "spiffe://yard/orchestrator",
					},
				},
			],
			{ expectedSeq: 0, actor, tenant: "local" },
		);
	} finally {
		store.close();
	}
}

describe("projectDeploymentView", () => {
	it("returns an honest empty view when no local cloud event source exists", async () => {
		const ctx = createManagementContext({ hoboHome: tempHome() });
		const result = await projectDeploymentView(ctx);
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_OK");
		expect(result.data?.available).toBe(false);
		expect(result.data?.source).toBe("none");
		expect(result.data?.deployments).toEqual([]);
		expect(result.data?.count).toBe(0);
		expect(result.data?.seq).toBe(0);
	});

	it("folds a durable yard event store into the saga graph", async () => {
		const home = tempHome();
		await seedYardStore(home, "demo");
		const ctx = createManagementContext({ hoboHome: home });

		const result = await projectDeploymentView(ctx);
		expect(result.ok).toBe(true);
		expect(result.data?.available).toBe(true);
		expect(result.data?.source).toBe("yard-eventstore");
		expect(result.data?.yards).toEqual(["demo"]);
		expect(result.data?.count).toBe(1);
		const row = result.data?.deployments[0];
		expect(row?.deploymentId).toBe("dep-1");
		expect(row?.status).toBe("deployed");
		expect(row?.bindleHash).toBe("sha256:abc");
		expect(row?.resources).toEqual({ web: "provisioned" });
	});

	it("scopes the fold to a named yard", async () => {
		const home = tempHome();
		await seedYardStore(home, "demo");
		const ctx = createManagementContext({ hoboHome: home });
		const missing = await projectDeploymentView(ctx, { yard: "other" });
		expect(missing.data?.available).toBe(false);
		const found = await projectDeploymentView(ctx, { yard: "demo" });
		expect(found.data?.available).toBe(true);
		expect(found.data?.count).toBe(1);
	});
});

describe("projectCredentialAudit", () => {
	it("returns an honest empty view when no local credential source exists", async () => {
		const ctx = createManagementContext({ hoboHome: tempHome() });
		const result = await projectCredentialAudit(ctx);
		expect(result.ok).toBe(true);
		expect(result.data?.available).toBe(false);
		expect(result.data?.sources).toEqual([]);
		expect(result.data?.rows).toEqual([]);
		expect(result.data?.count).toBe(0);
	});

	it("folds the local connection store into per-correlation audit rows", async () => {
		const home = tempHome();
		const ctx = createManagementContext({ hoboHome: home });
		stationInit(ctx, { name: "local", tenant: "local" });
		const created = connectionCreate(ctx, {
			provider: "asana",
			alias: "work",
			stationId: "station:local",
			scopes: ["tasks:read"],
		});
		expect(created.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const connectionId = (created.data as { connection: { id: string } })
			.connection.id;
		expect(connectionAuthorize(ctx, { idOrAlias: "work" }).ok).toBe(true);

		const result = await projectCredentialAudit(ctx);
		expect(result.ok).toBe(true);
		expect(result.data?.available).toBe(true);
		expect(result.data?.sources).toContain("connections-store");
		expect(result.data?.count).toBeGreaterThan(0);
		const row = result.data?.rows.find((r) =>
			r.connectionIds.includes(connectionId),
		);
		expect(row).toBeTruthy();
		expect(row?.timeline.length).toBeGreaterThan(0);
		expect(row?.timeline.some((t) => t.type === "connection.Created")).toBe(
			true,
		);
	});

	it("also folds yard-store token facts and filters by tenant", async () => {
		const home = tempHome();
		await seedYardStore(home, "demo");
		const ctx = createManagementContext({ hoboHome: home });

		const result = await projectCredentialAudit(ctx);
		expect(result.data?.available).toBe(true);
		expect(result.data?.sources).toContain("yard-eventstore");
		const row = result.data?.rows.find((r) => r.correlationId === "corr-dep-1");
		expect(row?.grantCount).toBe(1);
		expect(row?.grants["grant-1"]?.status).toBe("granted");

		const other = await projectCredentialAudit(ctx, { tenant: "other" });
		expect(other.data?.rows).toEqual([]);
	});
});

describe("partial projections are reported, not hidden", () => {
	// A yard we cannot read is not a yard with no deployments. Reporting the
	// second as the first is fabrication by omission — the consumer draws a
	// confident picture missing part of the estate.
	it("lists unreadable yard stores in skippedYards", async () => {
		const home = tempHome();
		const yards = join(home, "yards");
		mkdirSync(join(yards, "broken-yard"), { recursive: true });
		// A directory where the event store file is expected: unreadable, not absent.
		mkdirSync(join(yards, "broken-yard", "eventstore.sqlite"), {
			recursive: true,
		});
		const res = await projectDeploymentView(
			createManagementContext({ hoboHome: home }),
			{},
		);
		expect(res.ok).toBe(true);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		const view = res.data as { skippedYards: readonly string[] };
		expect(view.skippedYards).toContain("broken-yard");
	});
});
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: tests narrow known projection result shapes. */
