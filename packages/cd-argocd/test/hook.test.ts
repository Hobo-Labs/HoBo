import type {
	CdContext,
	ClusterSyncPort,
	Outcome,
	RunbookExecutor,
} from "@hobo/cd";
import { describe, expect, it } from "vitest";
import {
	ARGO_CD_SYNC_RUNBOOK,
	createArgoCdRunbookExecutor,
} from "../src/hook.js";

const ctx: CdContext = Object.freeze({
	tenant: "t1",
	principal: { kind: "service", id: "test" },
	now: () => 1,
});

describe("createArgoCdRunbookExecutor", () => {
	it("runs argocd-sync runbooks through the control port", async () => {
		let synced = false;
		const argocd: ClusterSyncPort = Object.freeze({
			target: "argocd:test",
			async getWorkload() {
				return { ok: true, value: {} };
			},
			async requestSync() {
				synced = true;
				return { ok: true, value: undefined };
			},
			async observeSync() {
				return {
					state: "converged",
					healthy: true,
					appliedRevision: "abc",
				};
			},
		});
		const inner: RunbookExecutor = {
			async run(): Promise<Outcome<{ marker: true }>> {
				return { ok: true, value: { marker: true } };
			},
		};
		const runbooks = createArgoCdRunbookExecutor(inner, argocd);
		const result = await runbooks.run(
			{
				path: ARGO_CD_SYNC_RUNBOOK,
				args: {
					application: "hobo-prod",
					appNamespace: "argocd",
					revision: "abc123",
				},
			},
			ctx,
		);
		expect(result.ok).toBe(true);
		expect(synced).toBe(true);
		if (result.ok) expect(result.value).toEqual({ syncRequested: true });
	});

	it.each([
		{ application: "hobo-prod", revision: "abc", appNamespace: 42 },
		{ application: "hobo-prod", revision: "abc", manual: "true" },
		{ application: "..", revision: "abc" },
	])("refuses malformed arguments without requesting a sync", async (args) => {
		let calls = 0;
		const cluster: ClusterSyncPort = {
			target: "cluster",
			async getWorkload() {
				return { ok: true, value: {} };
			},
			async requestSync() {
				calls += 1;
				return { ok: true, value: undefined };
			},
			async observeSync() {
				return { state: "converging", healthy: false, appliedRevision: "" };
			},
		};
		const inner: RunbookExecutor = {
			async run() {
				return { ok: true, value: {} };
			},
		};
		const result = await createArgoCdRunbookExecutor(inner, cluster).run(
			{ path: ARGO_CD_SYNC_RUNBOOK, args },
			ctx,
		);
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
	});

	it("delegates other runbook paths", async () => {
		const argocd: ClusterSyncPort = Object.freeze({
			target: "argocd:test",
			async getWorkload() {
				return { ok: true, value: {} };
			},
			async requestSync() {
				return { ok: true, value: undefined };
			},
			async observeSync() {
				return {
					state: "converging",
					healthy: false,
					appliedRevision: "",
				};
			},
		});
		const inner: RunbookExecutor = {
			async run(): Promise<Outcome<{ marker: true }>> {
				return { ok: true, value: { marker: true } };
			},
		};
		const runbooks = createArgoCdRunbookExecutor(inner, argocd);
		const result = await runbooks.run({ path: "other/runbook", args: {} }, ctx);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({ marker: true });
	});
});
