import { create } from "@bufbuild/protobuf";
import {
	type RunnerSlot,
	RunnerSlotSchema,
	type RunnerSlotState,
} from "@hobo/ci/fleet-v2";
import { describe, expect, it } from "vitest";
import {
	GithubRunnerSlotError,
	provisionGithubRunnerSlot,
	type RunnerSlotStore,
	reconcileGithubRunnerSlot,
} from "../src/fleet-v2/github-runner-slot.js";
import type { GithubTransport } from "../src/github.js";

type GithubCall = Readonly<{
	installationId: number;
	path: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: string;
}>;

type GithubFixture = Readonly<{
	api: GithubTransport;
	calls: GithubCall[];
}>;

class MemoryRunnerSlotStore implements RunnerSlotStore {
	readonly slot: RunnerSlot;
	quarantined = false;

	constructor(state: RunnerSlotState, externalRunnerId = "") {
		this.slot = create(RunnerSlotSchema, {
			id: "slot-1",
			accountId: "account-1",
			offerId: "offer-1",
			profileId: "profile-1",
			runnerName: "hobo-slot-1",
			state,
			capacityGroupId: "capacity-1",
			capacityCostUnits: 1,
			policyHash: "a".repeat(64),
			offerObservationHash: "b".repeat(64),
			bindingSecretHash: "c".repeat(64),
			externalRunnerId,
			incarnationId: "incarnation-1",
			createdAt: "2026-11-18T00:00:00.000Z",
		});
	}

	async runnerSlot(id: string): Promise<RunnerSlot | undefined> {
		return id === this.slot.id ? this.slot : undefined;
	}

	async transitionRunnerSlot(
		id: string,
		expected: RunnerSlotState,
		next: RunnerSlotState,
		externalRunnerId?: string,
	): Promise<RunnerSlot> {
		if (id !== this.slot.id || this.slot.state !== expected)
			throw new Error("transition conflict");
		this.slot.state = next;
		if (externalRunnerId !== undefined)
			this.slot.externalRunnerId = externalRunnerId;
		return this.slot;
	}

	async quarantineRunnerSlot(
		id: string,
		expected: RunnerSlotState,
	): Promise<RunnerSlot> {
		if (id !== this.slot.id || this.slot.state !== expected)
			throw new Error("quarantine conflict");
		this.slot.state = "uncertain";
		this.quarantined = true;
		return this.slot;
	}
}

function github(
	...steps: Array<(call: GithubCall) => Response | Promise<Response>>
): GithubFixture {
	const calls: GithubCall[] = [];
	return {
		calls,
		api: {
			async request(installationId, path, method = "GET", body) {
				const call = { installationId, path, method, body };
				calls.push(call);
				const step = steps.shift();
				if (!step) throw new Error("unexpected GitHub request");
				return step(call);
			},
		},
	};
}

const scope = {
	installationId: 10,
	repository: "Hobo-Labs/acceptance",
	runnerGroupId: 20,
	labels: ["hobo", "linux-x64"],
} as const;

function runners(
	...values: Array<{
		id: number;
		name?: string;
		labels?: readonly string[];
	}>
): Response {
	return Response.json({
		total_count: values.length,
		runners: values.map((runner) => ({
			...runner,
			name: runner.name ?? "hobo-slot-1",
			os: "linux",
			status: "offline",
			busy: false,
			labels: (runner.labels ?? scope.labels).map((name, id) => ({
				id,
				name,
				type: "custom",
			})),
		})),
	});
}

describe("strict GitHub runner slots", () => {
	it("creates one deterministic JIT runner after proving the name is free", async () => {
		const store = new MemoryRunnerSlotStore("reserved");
		const transport = github(
			() => runners(),
			(call) => {
				expect(JSON.parse(call.body ?? "")).toEqual({
					name: "hobo-slot-1",
					runner_group_id: 20,
					labels: ["hobo", "linux-x64"],
					work_folder: "_hobo_work",
				});
				return Response.json(
					{
						encoded_jit_config: "jit-config",
						runner: {
							id: 101,
							name: "hobo-slot-1",
							os: "unknown",
							status: "offline",
							busy: false,
							labels: [{ id: 1, name: "hobo", type: "custom" }],
						},
					},
					{ status: 201 },
				);
			},
		);

		await expect(
			provisionGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).resolves.toEqual({
			kind: "created",
			runnerId: 101,
			encodedJitConfig: "jit-config",
		});
		expect(store.slot).toMatchObject({
			state: "registered",
			externalRunnerId: "101",
		});
		expect(transport.calls).toHaveLength(2);
	});

	it("quarantines the provider scope when the deterministic name is occupied", async () => {
		const store = new MemoryRunnerSlotStore("reserved");
		const transport = github(() => runners({ id: 202 }));

		await expect(
			provisionGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toMatchObject({ code: "runner-foreign" });
		expect(store.slot.state).toBe("uncertain");
		expect(store.quarantined).toBe(true);
		expect(transport.calls).toHaveLength(1);
	});

	it("quarantines an incomplete runner listing before registration", async () => {
		const store = new MemoryRunnerSlotStore("reserved");
		const transport = github(() =>
			Response.json({ total_count: 101, runners: [] }),
		);
		await expect(
			provisionGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toMatchObject({ code: "registration-uncertain" });
		expect(store.quarantined).toBe(true);
		expect(transport.calls).toHaveLength(1);
	});

	it("does not retry an ambiguous registration", async () => {
		const store = new MemoryRunnerSlotStore("reserved");
		const transport = github(
			() => runners(),
			async () => {
				throw new Error("connection reset");
			},
		);

		await expect(
			provisionGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toMatchObject({ code: "registration-uncertain" });
		expect(store.quarantined).toBe(true);
		expect(transport.calls).toHaveLength(2);
	});

	it("releases a definitively rejected registration", async () => {
		const store = new MemoryRunnerSlotStore("reserved");
		const transport = github(
			() => runners(),
			() => Response.json({ message: "invalid group" }, { status: 400 }),
			() => runners(),
		);

		await expect(
			provisionGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toMatchObject({ code: "registration-rejected" });
		expect(store.slot.state).toBe("released");
		expect(store.quarantined).toBe(false);
	});

	it("adopts only the recorded runner identity and labels", async () => {
		const store = new MemoryRunnerSlotStore("registered", "303");
		const transport = github(() => runners({ id: 303 }));

		await expect(
			reconcileGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).resolves.toEqual({ kind: "adopted", runnerId: 303 });
		expect(store.quarantined).toBe(false);
	});

	it("recovers a recorded provisioning identity without registering again", async () => {
		const store = new MemoryRunnerSlotStore("provisioning", "303");
		const transport = github(() => runners({ id: 303 }));

		await expect(
			reconcileGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).resolves.toEqual({ kind: "adopted", runnerId: 303 });
		expect(store.slot.state).toBe("registered");
		expect(transport.calls).toHaveLength(1);
	});

	it("quarantines a runner missing required labels", async () => {
		const store = new MemoryRunnerSlotStore("registered", "303");
		const transport = github(() => runners({ id: 303, labels: ["hobo"] }));

		await expect(
			reconcileGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toMatchObject({ code: "runner-foreign" });
		expect(store.quarantined).toBe(true);
	});

	it("quarantines a same-name runner with a foreign identity", async () => {
		const store = new MemoryRunnerSlotStore("registered", "303");
		const transport = github(() => runners({ id: 404 }));

		await expect(
			reconcileGithubRunnerSlot({
				store,
				github: transport.api,
				slotId: "slot-1",
				scope,
			}),
		).rejects.toBeInstanceOf(GithubRunnerSlotError);
		expect(store.slot.state).toBe("uncertain");
		expect(store.quarantined).toBe(true);
	});
});
