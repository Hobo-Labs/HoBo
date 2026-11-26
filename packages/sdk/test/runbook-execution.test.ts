import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { policyPack, rule } from "../src/policy.js";
import { runbook } from "../src/runbook.js";
import {
	executeRunbook,
	type RunbookExecutionOptions,
} from "../src/runbook-execution.js";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "sdk-runbook-"));
	const stateFile = join(dir, "deployment.json");
	await writeFile(stateFile, JSON.stringify({ active: "primary" }));
	const store = createRuntimeLocalEventStore({ dataDir: dir });
	let mutations = 0;
	const declaration = runbook("recover-api", {
		on: { alert: "api-down", severity: ">=SEV2" },
		diagnose: ["inspect api"],
		fix: [
			{
				when: "provider-degraded",
				do: "failover",
				gate: "require-approval",
				to: "secondary",
			},
		],
	});
	const options: RunbookExecutionOptions = {
		store,
		tenant: "tenant-a",
		actor: { kind: "user", id: "user:operator" },
		executionId: "incident-1",
		incident: { alert: "api-down", severity: "SEV1" },
		policyPack: policyPack("ops", {}, []),
		queries: {
			"inspect api": async () => ({
				conditions: ["provider-degraded"],
				evidence: JSON.parse(await readFile(stateFile, "utf8")),
			}),
		},
		actions: {
			failover: {
				async execute(args) {
					mutations++;
					await writeFile(stateFile, JSON.stringify({ active: args.to }));
				},
				async verify(args) {
					const state = JSON.parse(await readFile(stateFile, "utf8"));
					return { satisfied: state.active === args.to, evidence: state };
				},
			},
		},
	};
	return {
		dir,
		store,
		stateFile,
		declaration,
		options,
		mutations: () => mutations,
		async close() {
			store.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("operator runbook execution", () => {
	it("gates actual remediation, verifies the postcondition, persists and replays without duplicate effects", async () => {
		const f = await fixture();
		try {
			expect(await executeRunbook(f.declaration, f.options)).toMatchObject({
				status: "blocked",
				reason: "approval-required",
			});
			expect(f.mutations()).toBe(0);
			const approved = { ...f.options, authorizeApproval: async () => true };
			expect(await executeRunbook(f.declaration, approved)).toMatchObject({
				status: "completed",
				reason: "verified",
			});
			expect(JSON.parse(await readFile(f.stateFile, "utf8"))).toEqual({
				active: "secondary",
			});
			expect(await executeRunbook(f.declaration, approved)).toMatchObject({
				status: "completed",
				reason: "replayed-completed",
			});
			expect(f.mutations()).toBe(1);
			const events = [];
			for await (const event of f.store.read(
				`sdk-runbook:${JSON.stringify(["tenant-a", "incident-1"])}`,
			))
				events.push(event.type);
			expect(events).toContain("policy.Decided");
			expect(events).toContain("runbook.RemediationCompleted");
			expect(events.at(-1)).toBe("runbook.Completed");
			const pact = JSON.parse(
				await readFile(
					new URL(
						"../contracts/pacts/sdk-execution-boundary.pact.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			for await (const event of f.store.read(
				`sdk-runbook:${JSON.stringify(["tenant-a", "incident-1"])}`,
			)) {
				if (event.type === pact.messages[0].contents.type)
					expect(event.data).toMatchObject(pact.messages[0].contents.data);
			}
		} finally {
			await f.close();
		}
	});
	it("recovers a committed-but-interrupted effect by observing it instead of writing twice", async () => {
		const f = await fixture();
		try {
			const base = f.options.actions.failover;
			if (!base) throw new Error("failover action is missing");
			const options = {
				...f.options,
				authorizeApproval: async () => true,
				actions: {
					failover: {
						...base,
						async execute(args: Parameters<typeof base.execute>[0]) {
							await base.execute(args, "incident-1");
							throw new Error("connection lost after commit");
						},
					},
				},
			};
			await expect(executeRunbook(f.declaration, options)).rejects.toThrow(
				"connection lost",
			);
			expect(await executeRunbook(f.declaration, options)).toMatchObject({
				status: "completed",
			});
			expect(f.mutations()).toBe(1);
		} finally {
			await f.close();
		}
	});
	it("keeps deny policy above approval and never applies an unverified effect", async () => {
		const f = await fixture();
		try {
			const denied = {
				...f.options,
				authorizeApproval: async () => true,
				policyPack: policyPack("deny", { mandatory: true }, [
					rule("no-write", { phase: "apply", when: {}, effect: "deny" }),
				]),
			};
			expect(await executeRunbook(f.declaration, denied)).toMatchObject({
				status: "blocked",
				reason: "policy-deny",
			});
			expect(f.mutations()).toBe(0);
			await expect(
				executeRunbook(f.declaration, {
					...f.options,
					authorizeApproval: async () => true,
					actions: {
						failover: {
							execute: async () => {},
							verify: async () => ({
								satisfied: false,
								evidence: "no mutation observed",
							}),
						},
					},
				}),
			).rejects.toMatchObject({ code: "SDK_RUNBOOK_EFFECT_UNVERIFIED" });
		} finally {
			await f.close();
		}
	});
	it("rejects replaying an execution id with a different declaration", async () => {
		const f = await fixture();
		try {
			await executeRunbook(f.declaration, f.options);
			await expect(
				executeRunbook({ ...f.declaration, name: "another" }, f.options),
			).rejects.toMatchObject({ code: "SDK_RUNBOOK_REPLAY_MISMATCH" });
		} finally {
			await f.close();
		}
	});
	it("isolates tenant/id tuples even when their colon-joined spellings collide", async () => {
		const f = await fixture();
		try {
			const first = {
				...f.options,
				tenant: "a:b",
				executionId: "c",
				authorizeApproval: async () => true,
			};
			expect(await executeRunbook(f.declaration, first)).toMatchObject({
				status: "completed",
			});
			const second = { ...f.options, tenant: "a", executionId: "b:c" };
			expect(await executeRunbook(f.declaration, second)).toMatchObject({
				status: "blocked",
				reason: "approval-required",
			});
			const sameIdOtherTenant = {
				...f.options,
				tenant: "other",
				executionId: "c",
			};
			expect(
				await executeRunbook(f.declaration, sameIdOtherTenant),
			).toMatchObject({ status: "blocked", reason: "approval-required" });
			expect(f.mutations()).toBe(1);
		} finally {
			await f.close();
		}
	});
});
