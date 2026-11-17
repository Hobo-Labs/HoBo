import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";
import { executeRankedIacTargets } from "../src/iac-target-routing.js";

const digest = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
const stores: ReturnType<typeof createSqliteIacRouteAuthority>[] = [];
function connect(path?: string) {
	const directory =
		path === undefined
			? mkdtempSync(join(tmpdir(), "hobo-route-dispatch-"))
			: undefined;
	if (directory) directories.push(directory);
	if (path === undefined && directory === undefined)
		throw new Error("missing directory");
	// SAFETY: a directory exists when path is absent.
	const databasePath = path ?? join(directory as string, "route.sqlite");
	const authority = createSqliteIacRouteAuthority({ path: databasePath });
	stores.push(authority);
	return { authority, path: databasePath };
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function ranking(target: string) {
	return {
		tenantId: "tenant",
		coverage: "complete" as const,
		budget: {
			evaluation: "not-evaluated" as const,
			reservation: "not-created" as const,
		},
		rejected: [],
		ranking: [
			{
				targetId: target,
				rank: 1,
				incrementalBilled: { decimal: "1", currency: "USD" },
				source: "developer-supplied" as const,
				modelId: "model",
				revision: "1",
				modelHash: digest,
				inventoryHash: digest,
				quoteHash: digest,
			},
		],
	};
}
describe("ranked routes share durable execution ownership", () => {
	it("blocks a different target and financial authority after an unknown prior provider effect", async () => {
		const first = connect();
		let firstEffects = 0;
		let otherEffects = 0;
		const result = await executeRankedIacTargets({
			authority: first.authority,
			tenantId: "tenant",
			requestId: "request",
			ranking: ranking("first"),
			candidates: [
				{
					targetId: "first",
					run: async (_request, _expected, permit) => {
						expect(await first.authority.verifyAttempt(permit)).toBe(true);
						firstEffects++;
						throw new Error("provider acknowledgement lost");
					},
				},
			],
		});
		expect(result.status).toBe("uncertain");
		const second = connect(first.path);
		const retry = await executeRankedIacTargets({
			authority: second.authority,
			tenantId: "tenant",
			requestId: "request",
			ranking: ranking("other"),
			candidates: [
				{
					targetId: "other",
					run: async () => {
						otherEffects++;
						throw new Error("must not run");
					},
				},
			],
		});
		expect(retry).toMatchObject({ status: "uncertain", targetId: "first" });
		expect(firstEffects).toBe(1);
		expect(otherEffects).toBe(0);
	});
	it("does not run any target when a route claim acknowledgement is lost", async () => {
		const { authority } = connect();
		let effects = 0;
		const broken = {
			...authority,
			async claim(input: Parameters<typeof authority.claim>[0]) {
				await authority.claim(input);
				throw new Error("ack lost");
			},
		};
		const result = await executeRankedIacTargets({
			authority: broken,
			tenantId: "tenant",
			requestId: "lost",
			ranking: ranking("first"),
			candidates: [
				{
					targetId: "first",
					run: async () => {
						effects++;
						throw new Error("must not run");
					},
				},
			],
		});
		expect(result.status).toBe("uncertain");
		expect(effects).toBe(0);
	});

	it("blocks concurrent different rankings before the second target can admit", async () => {
		const first = connect();
		const second = connect(first.path);
		let unblock: (() => void) | undefined;
		let signal: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			signal = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		let other = 0;
		const running = executeRankedIacTargets({
			authority: first.authority,
			tenantId: "tenant",
			requestId: "concurrent",
			ranking: ranking("first"),
			candidates: [
				{
					targetId: "first",
					run: async (requestId, expected, permit) => {
						expect(await first.authority.consumeAttempt(permit)).toBe(true);
						signal?.();
						await waiting;
						return {
							outputs: {},
							admission: {
								requestId,
								targetId: "first",
								status: "admitted",
								code: "",
								message: "",
								budget: { evaluation: "allowed", reservation: "held" },
								reservation: { reservationId: "iac:concurrent" },
								...expected,
							},
						};
					},
				},
			],
		});
		await started;
		const competing = await executeRankedIacTargets({
			authority: second.authority,
			tenantId: "tenant",
			requestId: "concurrent",
			ranking: ranking("other"),
			candidates: [
				{
					targetId: "other",
					run: async () => {
						other++;
						throw new Error("must not run");
					},
				},
			],
		});
		expect(competing).toMatchObject({ status: "uncertain", targetId: "first" });
		unblock?.();
		expect((await running).status).toBe("selected");
		expect(other).toBe(0);
	});

	it("durably records a no-effect denial before trying the next provider", async () => {
		const { authority } = connect();
		const first = ranking("first").ranking[0];
		const second = { ...first, targetId: "second", rank: 2 };
		const candidates = [first, second];
		const combined = { ...ranking("first"), ranking: candidates };
		const result = await executeRankedIacTargets({
			authority,
			tenantId: "tenant",
			requestId: "fallback",
			ranking: combined,
			candidates: candidates.map((entry) => ({
				targetId: entry.targetId,
				run: async (requestId, expected, permit) => {
					expect(await authority.consumeAttempt(permit)).toBe(true);
					if (entry.targetId === "first")
						throw {
							admission: {
								requestId,
								targetId: "first",
								status: "denied",
								code: "budget.exhausted",
								message: "",
								budget: { evaluation: "denied", reservation: "not-created" },
							},
						};
					const snapshot = await authority.inspect({
						tenantId: "tenant",
						requestId: "fallback",
					});
					expect(snapshot?.attempts.map((attempt) => attempt.status)).toEqual([
						"denied",
						"running",
					]);
					return {
						outputs: {},
						admission: {
							requestId,
							targetId: "second",
							status: "admitted",
							code: "",
							message: "",
							budget: { evaluation: "allowed", reservation: "held" },
							reservation: { reservationId: "iac:fallback" },
							...expected,
						},
					};
				},
			})),
		});
		expect(result).toMatchObject({ status: "selected", targetId: "second" });
	});
});
