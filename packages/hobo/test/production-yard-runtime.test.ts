import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	BudgetIdentitySchema,
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
} from "@hobo/broker";
import { afterEach, describe, expect, it } from "vitest";
import {
	createProductionYardRuntime,
	type ProductionYardRuntimeOptions,
} from "../src/compose.js";
import { createHostingBudgetAuthorityBridge } from "../src/hosting-budget-authority.js";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";
import { createResolverHostingTransitionProvider } from "../src/resolver-hosting-provider.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "production-yard-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const now = Date.parse("2026-10-30T00:00:00Z");
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dataDir, "finance.sqlite"),
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: create(BudgetIdentitySchema, {
				tenantId: "tenant",
				budgetId: "budget",
				periodId: "period",
				policyRevision: "r1",
			}),
			limitMicros: 100,
			observedAt: new Date(now).toISOString(),
			validUntil: new Date(now + 60_000).toISOString(),
		}),
		now: () => new Date(now).toISOString(),
	});
	dispose.push(() => authority.close());
	const unused = async (): Promise<never> => {
		throw new Error("financial I/O must not run while composing a runtime");
	};
	const bridge = createHostingBudgetAuthorityBridge({
		authority,
		scopeId: "scope",
		nowMs: () => now,
		resolve: unused,
		revalidate: unused,
		settlement: unused,
	});
	const context = {
		tenantId: "tenant",
		actor: { kind: "service", id: "worker" } as const,
		fenceToken: 1n,
	};
	const options: ProductionYardRuntimeOptions = {
		dataDir,
		env: {},
		nowMs: () => now,
		configureHosting: async ({ store, defaultRegistry }) => {
			const journal = createDurableHostingMutationJournal({
				store,
				...context,
				nowMs: () => now,
			});
			const provider = createResolverHostingTransitionProvider({
				store,
				context,
				mutationJournal: journal,
				artifacts: new Map(),
				resourceArtifacts: new Map(),
				providers: new Map(),
				routing: new Map(),
				health: new Map(),
				billing: { observe: async () => [] },
				nowMs: () => now,
			});
			await store.commit({
				streamId: "composition:probe",
				append: {
					tenant: "tenant",
					actor: context.actor,
					fenceToken: 1n,
					expectedSeq: 0,
				},
				events: [
					{
						type: "hosting.ConfigurationObserved",
						data: { source: "production-config" },
					},
				],
			});
			return {
				registry: defaultRegistry,
				authority: bridge,
				budgetId: "budget",
				execution: {
					provider,
					context,
					templates: new Map(),
					authorize: async () => ({ allowed: false }),
				},
			};
		},
	};
	return { options, authority };
}
describe("production Yard runtime composition", () => {
	it("shares persistent SQLite facts with the gateway and supervisor and preserves them on close", async () => {
		const fx = fixture();
		const runtime = await createProductionYardRuntime(fx.options);
		expect(runtime.hostingBudgetRequired).toBe(true);
		expect(runtime.hostingExecution).toBe(runtime.hostingController.execution);
		const events = [];
		for await (const event of runtime.store.read("composition:probe"))
			events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0].data).toEqual({ source: "production-config" });
		expect(events[0].ts).toBe("2026-10-30T00:00:00.000Z");
		runtime.close();
		const reopened = await createProductionYardRuntime({
			...fx.options,
			configureHosting: async (input) => {
				const history = [];
				for await (const event of input.store.read("composition:probe"))
					history.push(event);
				expect(history).toHaveLength(1);
				// Constructor validation of the financial/native proof requirements occurs
				// after asynchronous credential/provider initialization.
				throw new Error("stop after observing persisted configuration");
			},
		}).catch((error) => error);
		expect(reopened).toBeInstanceOf(Error);
		expect(reopened.message).toContain("persisted configuration");
		expect(fx.authority.read().reservedMicros).toBe(0);
	});
	it("refuses an ephemeral production directory before configuration or financial effects", async () => {
		const fx = fixture();
		let called = false;
		await expect(
			createProductionYardRuntime({
				...fx.options,
				dataDir: "relative-temporary-path",
				configureHosting: async (input) => {
					called = true;
					return fx.options.configureHosting(input);
				},
			}),
		).rejects.toThrow("absolute persistent");
		expect(called).toBe(false);
		expect(fx.authority.read().reservedMicros).toBe(0);
	});
});
