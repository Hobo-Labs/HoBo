import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	parseResolveOutcome,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	ResourceLifecycleObservationRecordSchema,
} from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableHostingResourceRepository } from "../src/hosting-resource-store.js";
import { parseJsonValue } from "../src/json.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
const scope = {
	tenantId: "tenant",
	providerId: "neon",
	providerAccountId: "anonymous",
	scopeId: "deployment-1",
};
const record: ResolveOutcome = {
	contract: RESOLVER_CONTRACT,
	action: "create",
	physicalId: "db-1",
	outputs: {
		claimRef: "custody://neon/claim",
		endpoint: "https://db.example.test",
	},
	diagnostics: [],
};
const observation = (observedAtMs = 1000) =>
	create(ResourceLifecycleObservationRecordSchema, {
		...scope,
		productId: "neon.database/v1",
		resourceId: "db",
		operationId: "prepare-1",
		physicalId: "db-1",
		status: "ready",
		observedAtMs,
		evidenceRef: "provider://read/1",
		operationTerminal: true,
	});
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-resource-store-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	function connect(resourceScope = scope, fenceToken = 1n) {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-10-29T12:00:00Z"),
		});
		dispose.push(() => store.close());
		return {
			store,
			repository: createDurableHostingResourceRepository({
				store,
				scope: resourceScope,
				actor: { kind: "service", id: "hosting-worker" },
				fenceToken,
				nowMs: () => 1100,
				codec: {
					serialize: (item: ResolveOutcome) => JSON.stringify(item),
					parse: (json: string) => parseResolveOutcome(parseJsonValue(json)),
				},
			}),
		};
	}
	return { connect };
}
describe("durable scoped provider resource records", () => {
	it("survives reopening and isolates tenants, accounts and deployment incarnations", async () => {
		const fx = fixture();
		await fx.connect().repository.write("db", record);
		expect(await fx.connect().repository.read("db")).toEqual(record);
		const reordered = {
			scopeId: scope.scopeId,
			providerAccountId: scope.providerAccountId,
			providerId: scope.providerId,
			tenantId: scope.tenantId,
		};
		expect(await fx.connect(reordered).repository.read("db")).toEqual(record);
		for (const field of ["tenantId", "providerAccountId", "scopeId"] as const)
			expect(
				await fx
					.connect({ ...scope, [field]: "another" })
					.repository.read("db"),
			).toBeUndefined();
	});
	it("allows idempotent writers but refuses a racing different physical identity", async () => {
		const fx = fixture(),
			a = fx.connect(),
			b = fx.connect();
		const results = await Promise.allSettled([
			a.repository.write("db", record),
			b.repository.write("db", { ...record, physicalId: "db-2" }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const saved = await a.repository.read("db");
		if (!saved) throw new Error("winner missing");
		await Promise.all([
			a.repository.write("db", saved),
			b.repository.write("db", saved),
		]);
	});
	it("never persists raw provider secrets or claim URLs", async () => {
		const { repository, store } = fixture().connect();
		for (const outputs of [
			{ password: "sensitive" },
			{ claimUrl: "https://claim.test/token" },
			{ connectionString: "postgresql://user:password@host/db" },
			{ endpoint: "rediss://default:password@host:6379" },
		])
			await expect(
				repository.write("db", { ...record, outputs }),
			).rejects.toThrow(/custody|credential/u);
		const events = [];
		for await (const event of store.readAll()) events.push(event);
		expect(events).toHaveLength(0);
	});
	it("keeps observations monotonic, physically scoped, and terminal absence irreversible", async () => {
		const fx = fixture(),
			{ repository } = fx.connect();
		await repository.writeObservation("db", observation());
		await repository.writeObservation("db", observation());
		await expect(
			repository.writeObservation("db", observation(999)),
		).rejects.toThrow("regresses");
		await expect(
			repository.writeObservation("db", {
				...observation(1001),
				physicalId: "other",
			}),
		).rejects.toThrow("identity");
		await expect(
			repository.writeObservation("db", {
				...observation(1001),
				providerAccountId: "foreign",
			}),
		).rejects.toThrow("foreign");
		const absent = {
			...observation(1002),
			status: "absent",
			usageFinal: true,
			settledMicros: 0,
			usageEvidenceRef: "provider://final",
		};
		await repository.writeObservation("db", absent);
		expect(await fx.connect().repository.readObservation("db")).toEqual(absent);
		await expect(
			repository.writeObservation("db", observation(1003)),
		).rejects.toThrow("regresses");
	});
	it("retains the newest observation under concurrent SQLite writes", async () => {
		const fx = fixture(),
			a = fx.connect(),
			b = fx.connect();
		await a.repository.writeObservation("db", observation());
		await Promise.allSettled([
			a.repository.writeObservation("db", observation(1001)),
			b.repository.writeObservation("db", observation(1002)),
		]);
		expect((await a.repository.readObservation("db"))?.observedAtMs).toBe(1002);
	});
	it("rejects future and stale observations before appending", async () => {
		const { repository } = fixture().connect();
		await expect(
			repository.writeObservation("db", observation(1101)),
		).rejects.toThrow("future");
		await expect(
			repository.writeObservation("db", { ...observation(), observedAtMs: -1 }),
		).rejects.toThrow();
	});
});
