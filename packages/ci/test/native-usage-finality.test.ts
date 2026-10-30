import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountSchema,
	ConfigurationSchema,
	OfferSchema,
	PipelineStepResultSchema,
} from "../src/_generated/ci_pb.js";
import {
	BackendUnavailableError,
	type PipelineBackend,
	type PipelineUsageScope,
	parsePipeline,
} from "../src/execution.js";
import { PipelineScheduler } from "../src/scheduler.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-27T12:00:00Z";
const stores = new Set<LeaseStore>();
const directories: string[] = [];
afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
function account() {
	return create(AccountSchema, {
		id: "tenant",
		budgetMicros: 10000,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		offers: [
			create(OfferSchema, {
				id: "native",
				provider: "github",
				providerAccountId: "owned-native-account",
				enabled: true,
				bridgeAcknowledged: true,
				concurrency: 1,
				budgetMicros: 10000,
				priceMicrosPerMinute: 100,
				observedAt: "2026-10-27T00:00:00Z",
				validUntil: "2026-10-28T00:00:00Z",
				runsOn: "ubuntu-24.04",
				sourceUrl: "https://example.test/native-usage",
			}),
		],
	});
}
function pipeline(id = "build") {
	return parsePipeline(
		JSON.stringify({
			id,
			accountId: "tenant",
			timeoutSeconds: 30,
			steps: [{ id: "test", argv: ["true"] }],
		}),
	);
}
function store(path = ":memory:") {
	const result = new LeaseStore(path);
	stores.add(result);
	return result;
}
function finalUsage(scope: PipelineUsageScope) {
	return {
		...scope,
		usageFinal: true,
		stopped: true,
		completedAt: NOW,
		billedMinutes: 1,
		billedFreeMinutes: 0,
		paidMicros: 113,
		usageEvidenceRef: "native:invoice:execution-1",
		sourceStoppedEvidenceRef: "native:stopped:execution-1",
	};
}
function backend(
	observe?: PipelineBackend["observeFinalUsage"],
): PipelineBackend {
	const result: PipelineBackend = {
		kind: "gh-actions",
		capabilities: ["commands", "cancellation"],
		async open(_input, _signal, scope) {
			if (!scope) throw new Error("execution scope missing");
			scope.authorizeAllocation();
			scope.recordExternalOperationId("execution-1");
			return {
				async run(step) {
					return create(PipelineStepResultSchema, { id: step.id });
				},
				async artifact() {
					throw new Error("no artifacts");
				},
				async close() {},
			};
		},
	};
	if (observe) result.observeFinalUsage = observe;
	return result;
}

describe("native CI usage finality and persisted execution binding", () => {
	it("records provider-final actual charges independently of elapsed command time", async () => {
		const s = store();
		const a = account();
		const scheduler = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", backend(async (scope) => finalUsage(scope))]]),
			() => NOW,
		);
		expect((await scheduler.execute(a, pipeline())).status).toBe("succeeded");
		expect(s.all()[0]).toMatchObject({
			state: "completed",
			usageProvenance: "provider-final",
			paidMicros: 113,
			externalOperationId: "execution-1",
			providerAccountId: "owned-native-account",
		});
	});
	it("preserves missing final usage across restart and reconciles by pinned native identity without reopening", async () => {
		const path = await mkdtemp(join(tmpdir(), "hobo-ci-native-finality-"));
		directories.push(path);
		const s = store(join(path, "leases.sqlite"));
		const a = account();
		const first = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", backend(async () => undefined)]]),
			() => NOW,
		);
		expect((await first.execute(a, pipeline())).status).toBe("uncertain");
		const lease = s.all()[0];
		if (!lease) throw new Error("missing durable lease");
		s.close();
		stores.delete(s);
		const reopened = store(join(path, "leases.sqlite"));
		let opens = 0;
		const readOnly: PipelineBackend = {
			kind: "gh-actions",
			capabilities: ["commands", "cancellation"],
			async open() {
				opens++;
				throw new Error("must not open");
			},
			async observeFinalUsage(scope) {
				return finalUsage(scope);
			},
		};
		const recovered = new PipelineScheduler(
			reopened,
			a.id,
			new Map([["native", readOnly]]),
			() => "2026-11-01T00:00:00Z",
		);
		expect(await recovered.reconcile(lease.id)).toMatchObject({
			state: "completed",
			usageProvenance: "provider-final",
			paidMicros: 113,
		});
		expect(opens).toBe(0);
		reopened.rebuild();
		expect(reopened.get(lease.id)?.externalOperationId).toBe("execution-1");
	});
	it("rejects foreign-account final usage and keeps the original hold uncertain", async () => {
		const s = store();
		const a = account();
		const bad = backend(async (scope) => ({
			...finalUsage(scope),
			providerAccountId: "foreign",
		}));
		const scheduler = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", bad]]),
			() => NOW,
		);
		await expect(scheduler.execute(a, pipeline())).rejects.toThrow(
			"does not match",
		);
		expect(s.all()[0]?.state).toBe("uncertain");
		expect(s.all()[0]?.reservedPaidMicros).toBe(200);
		const lease = s.all()[0];
		if (!lease) throw new Error("missing lease");
		expect(lease.result?.status).toBe("succeeded");
		const recovered = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", backend(async (scope) => finalUsage(scope))]]),
			() => NOW,
		);
		await recovered.reconcile(lease.id);
		expect((await recovered.execute(a, pipeline())).status).toBe("succeeded");
	});
	it("rechecks after asynchronous native preflight and retains a potentially allocated hold", async () => {
		const s = store();
		const a = account();
		const config = create(ConfigurationSchema, { accounts: [a] });
		s.configure(config, 0, NOW);
		let mutations = 0;
		const actual: PipelineBackend = {
			kind: "gh-actions",
			capabilities: ["commands", "cancellation"],
			async open(_input, _signal, scope) {
				await Promise.resolve();
				const current = config.accounts[0];
				if (!current || !scope) throw new Error("fixture");
				current.budgetMicros = 0;
				s.configure(config, 1, NOW);
				scope.authorizeAllocation();
				mutations++;
				throw new Error("must not mutate");
			},
		};
		const scheduler = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", actual]]),
			() => NOW,
		);
		expect((await scheduler.execute(a, pipeline())).status).toBe("uncertain");
		expect(mutations).toBe(0);
		expect(s.all()[0]?.state).toBe("uncertain");
	});
	it("cannot reinterpret refusal after native identity binding as safe cross-provider fallback", async () => {
		const s = store();
		const a = account();
		let opens = 0;
		const wrong: PipelineBackend = {
			kind: "gh-actions",
			capabilities: ["commands", "cancellation"],
			async open(_input, _signal, scope) {
				opens++;
				if (!scope) throw new Error("scope missing");
				scope.recordExternalOperationId("execution-1");
				throw new BackendUnavailableError("late refusal after allocation");
			},
		};
		const scheduler = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", wrong]]),
			() => NOW,
		);
		await expect(scheduler.execute(a, pipeline())).rejects.toThrow(
			"late refusal",
		);
		expect(s.all()[0]?.state).toBe("uncertain");
		expect(opens).toBe(1);
	});
	it("labels compatibility wall-clock accounting as estimated", async () => {
		const s = store();
		const a = account();
		const scheduler = new PipelineScheduler(
			s,
			a.id,
			new Map([["native", backend()]]),
			() => NOW,
		);
		expect((await scheduler.execute(a, pipeline())).status).toBe("succeeded");
		expect(s.all()[0]).toMatchObject({
			usageProvenance: "estimated",
			paidMicros: 100,
		});
	});
});
