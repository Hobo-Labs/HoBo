import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clone, create } from "@bufbuild/protobuf";
import {
	BudgetAdmissionDeniedError,
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	type Lease,
	LeaseSchema,
} from "@hobo/ci";
import { canonicalBudgetPolicyJson, parseBudgetPolicy } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkerBudgetAdapter } from "../scripts/worker-budget-adapter.mts";

const now = "2026-10-30T12:00:00Z";
const until = "2026-10-31T00:00:00Z";
const key = "__hoboWorkerBudgetAdapterFixture";
const cleanup: Array<() => void> = [];
afterEach(() => {
	Reflect.deleteProperty(globalThis, key);
	for (const done of cleanup.splice(0).reverse()) done();
});
function moduleFile(source: string) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-worker-budget-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "adapter.mjs");
	writeFileSync(path, source);
	return path;
}
// The loader test deliberately includes malformed external module objects.
// oxlint-disable-next-line anti-slop/no-object-parameters
function fixture(adapter: object) {
	Reflect.set(globalThis, key, adapter);
	return moduleFile(
		`export const createCiWorkerBudgetAdapter = () => globalThis.${key};`,
	);
}
function policy(enforcement: "strict" | "conservative") {
	return canonicalBudgetPolicyJson(
		parseBudgetPolicy({
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			revision: "v1",
			workloads: ["ci"],
			currency: "USD",
			limitMicros: 100,
			objective: "min-cost",
			enforcement,
			periodKind: "manual",
			constraints: [],
		}),
	);
}
function lease(enforcement: "strict" | "conservative") {
	return create(LeaseSchema, {
		id: "lease",
		accountId: "ci",
		offerId: "offer",
		provider: "github",
		providerAccountId: "owned",
		jobId: 1,
		originalRunId: 10,
		runAttempt: 1,
		repositoryId: 2,
		installationId: 3,
		repository: "org/repo",
		state: "reserved",
		reservedMinutes: 1,
		reservedPaidMicros: 60,
		priceMicrosPerMinute: 60,
		budgetTenantId: "tenant",
		budgetId: "shared",
		budgetPeriodId: "p1",
		budgetPolicyRevision: "v1",
		budgetPolicyDigest: policy(enforcement),
		budgetAdmissionAttempt: 1,
		createdAt: now,
	});
}
function quoteLease(row: Lease) {
	return create(HostingQuoteSchema, {
		quoteId: `quote:${ciReservationId(row)}`,
		yardId: `ci:${row.accountId}`,
		providerId: row.provider,
		ownerTenantId: row.budgetTenantId,
		currency: "USD",
		totalMicros: row.reservedPaidMicros,
		liabilityBoundMicros: row.reservedPaidMicros,
		observedAt: now,
		validUntil: until,
		components: [{ name: "native", costMicros: row.reservedPaidMicros }],
		requestDigest: ciRequestDigest(row),
		financialPlanHash: ciFinancialPlanHash(row),
		providerAccounts: [
			{
				providerAccountId: row.providerAccountId,
				liabilityMicros: row.reservedPaidMicros,
			},
		],
	});
}

describe("operator trusted worker budget adapter", () => {
	it("closes the trusted adapter if daemon startup fails after opening its journal", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-worker-startup-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const bin = join(root, "bin");
		mkdirSync(bin);
		const opened = join(root, "opened");
		const marker = join(root, "closed");
		const adapter = join(root, "adapter.mjs");
		writeFileSync(
			adapter,
			`
import { writeFileSync } from "node:fs";
const f = () => ({});
export function createCiWorkerBudgetAdapter() {
  writeFileSync(${JSON.stringify(opened)}, "opened");
  return { kind: "sqlite", options: { authority: { persistence: "durable-cas", read: f,
    lookup: f, reserve: f, claimExecution: f, uncertain: f, settle: f, release: f },
    quoteLease: f }, close() { writeFileSync(${JSON.stringify(marker)}, "closed"); } };
}`,
		);
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => {
				const key = name.toUpperCase();
				return (
					!key.startsWith("HOBO_CI_") &&
					!["DATABASE_URL", "PATH", "HOME", "NODE_OPTIONS"].includes(key)
				);
			}),
		);
		const daemon = join(
			dirname(fileURLToPath(import.meta.url)),
			"../scripts/isolated-worker-daemon-main.mts",
		);
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", daemon],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 20_000,
				env: {
					...env,
					PATH: bin,
					HOME: root,
					NODE_OPTIONS: "",
					HOBO_CI_GITHUB_APP_ID: "1",
					HOBO_CI_GITHUB_APP_PRIVATE_KEY: "test-key",
					HOBO_CI_CONFIG_JSON: "{}",
					HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID: "test-worker",
					HOBO_CI_WORKER_DB: join(root, "ci.sqlite"),
					HOBO_CI_WORKER_WORK_ROOT: join(root, "work"),
					HOBO_CI_WORKER_SLOTS: "1",
					HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB: "3072",
					HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB: "3072",
					HOBO_CI_WORKER_MEMORY_HEAVY_RESERVE_MB: "3072",
					HOBO_CI_PNPM_STORE_DIR: "",
					HOBO_CI_GIT_MIRROR: "1",
					HOBO_CI_GIT_MIRROR_ROOT: join(root, "git"),
					HOBO_CI_TRUSTED_BUDGET_ADAPTER: adapter,
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/spawn docker ENOENT/u);
		expect(existsSync(opened), result.stderr).toBe(true);
		expect(existsSync(marker), result.stderr).toBe(true);
	});
	it("leaves the adapter absent by default and rejects paths outside local absolute modules", async () => {
		expect(await loadWorkerBudgetAdapter(undefined, "sqlite")).toBeUndefined();
		for (const path of [
			"./adapter.mjs",
			"https://example.test/a.mjs",
			"/tmp/config.json",
		])
			await expect(loadWorkerBudgetAdapter(path, "sqlite")).rejects.toThrow(
				"invalid trusted CI budget adapter path",
			);
	});
	it("rejects a missing, throwing, wrong-backend or nondurable adapter without leaking secrets", async () => {
		const secret = "private-provider-credential";
		for (const path of [
			moduleFile("export const other = 1;"),
			moduleFile(`throw new Error(${JSON.stringify(secret)});`),
		]) {
			await expect(loadWorkerBudgetAdapter(path, "sqlite")).rejects.toThrow(
				"trusted CI budget adapter could not be initialized",
			);
			await expect(loadWorkerBudgetAdapter(path, "sqlite")).rejects.not.toThrow(
				secret,
			);
		}
		let closed = 0;
		const bad = fixture({
			kind: "postgres",
			options: { authority: { persistence: "memory" } },
			close: () => {
				closed++;
			},
		});
		await expect(loadWorkerBudgetAdapter(bad, "sqlite")).rejects.toThrow();
		expect(closed).toBe(1);
		const wrongBackend = fixture({
			kind: "postgres",
			options: {
				authority: {
					persistence: "durable-cas",
					read: () => ({}),
					lookup: () => ({}),
					reserve: () => ({}),
					claimExecution: () => ({}),
					uncertain: () => ({}),
					settle: () => ({}),
					release: () => ({}),
				},
				quoteLease: () => ({}),
			},
		});
		await expect(
			loadWorkerBudgetAdapter(wrongBackend, "postgres"),
		).rejects.toThrow("trusted CI budget adapter could not be initialized");
	});
	it("redacts asynchronous adapter operations and cleanup", async () => {
		const fail = async () => {
			throw new Error("secret-async-token");
		};
		const path = fixture({
			kind: "postgres",
			options: {
				authority: {
					persistence: "durable-cas",
					read: async () => ({}),
					lookup: fail,
					reserve: fail,
					claimExecution: fail,
					uncertain: fail,
					settle: fail,
					release: fail,
				},
				quoteLease: () => {
					throw new Error("secret-async-token");
				},
			},
			close: () => {
				throw new Error("secret-async-token");
			},
		});
		const adapter = await loadWorkerBudgetAdapter(path, "postgres");
		if (adapter?.kind !== "postgres") throw new Error("missing adapter");
		await expect(adapter.hooks.reserve(lease("conservative"))).rejects.toThrow(
			"trusted CI budget operation failed",
		);
		await expect(adapter.close()).rejects.toThrow(
			"trusted CI budget adapter cleanup failed",
		);
	});
	it("uses a real durable parent and refuses strict admission without native proof", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-worker-authority-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const authority = createSqliteBudgetAdmissionAuthority({
			path: join(dir, "budget.sqlite"),
			now: () => now,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "tenant",
					budgetId: "shared",
					periodId: "p1",
					policyRevision: "v1",
				},
				limitMicros: 100,
				observedAt: now,
				validUntil: until,
				providerAccounts: [{ providerAccountId: "owned", limitMicros: 100 }],
			}),
		});
		let closed = 0;
		const path = fixture({
			kind: "sqlite",
			options: { authority, quoteLease, now: () => now },
			close: () => {
				closed++;
				authority.close();
			},
		});
		const adapter = await loadWorkerBudgetAdapter(path, "sqlite");
		if (adapter?.kind !== "sqlite") throw new Error("missing adapter");
		expect(() => adapter.hooks.reserve(lease("strict"))).toThrow(
			"trusted CI budget operation failed",
		);
		expect(authority.read(now).reservedMicros).toBe(0);
		adapter.hooks.reserve(lease("conservative"));
		expect(authority.read(now).reservedMicros).toBe(60);
		const second = clone(LeaseSchema, lease("conservative"));
		second.jobId = 2;
		expect(() => adapter.hooks.reserve(second)).toThrow(
			BudgetAdmissionDeniedError,
		);
		const broken = fixture({
			kind: "sqlite",
			options: {
				authority,
				quoteLease: () => {
					throw new Error("secret-native-token");
				},
				now: () => now,
			},
		});
		const brokenAdapter = await loadWorkerBudgetAdapter(broken, "sqlite");
		if (brokenAdapter?.kind !== "sqlite") throw new Error("missing adapter");
		expect(() => brokenAdapter.hooks.reserve(second)).toThrow(
			"trusted CI budget operation failed",
		);
		expect(() => brokenAdapter.hooks.reserve(second)).not.toThrow(
			"secret-native-token",
		);
		expect(authority.read(now).reservedMicros).toBe(60);
		await brokenAdapter.close();
		const denied = new BudgetAdmissionDeniedError(
			"provider.exhausted",
			"secret-provider-token",
		);
		denied.stack = "secret-provider-token";
		Object.defineProperty(denied, "cause", { value: "secret-provider-token" });
		const denialPath = fixture({
			kind: "sqlite",
			options: {
				authority,
				quoteLease: () => {
					throw denied;
				},
				now: () => now,
			},
		});
		const denialAdapter = await loadWorkerBudgetAdapter(denialPath, "sqlite");
		if (denialAdapter?.kind !== "sqlite") throw new Error("missing adapter");
		try {
			denialAdapter.hooks.reserve(second);
			throw new Error("expected denial");
		} catch (error) {
			expect(error).toBeInstanceOf(BudgetAdmissionDeniedError);
			expect(error).toMatchObject({
				code: "provider.exhausted",
				message: "CI budget admission denied",
			});
			expect(String(error)).not.toContain("secret-provider-token");
			expect(error instanceof Error ? error.stack : "").not.toContain(
				"secret-provider-token",
			);
			expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
		}
		Object.defineProperty(denied, "code", {
			get: () => {
				throw new Error("secret-getter-token");
			},
		});
		expect(() => denialAdapter.hooks.reserve(second)).toThrow(
			"trusted CI budget operation failed",
		);
		expect(() => denialAdapter.hooks.reserve(second)).not.toThrow(
			"secret-getter-token",
		);
		await denialAdapter.close();
		await adapter.close();
		expect(closed).toBe(1);
	});
});
