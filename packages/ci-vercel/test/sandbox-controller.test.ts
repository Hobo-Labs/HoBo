import { create } from "@bufbuild/protobuf";
import {
	ConnectionSchema,
	JobSchema,
	type Lease,
	LeaseSchema,
	SandboxPricingSchema,
} from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import {
	createSandboxController,
	type IsolatedSandboxDriver,
	type SandboxAuthority,
	type SandboxLaunchFailure,
	type SandboxLeaseStore,
	type SandboxProxyDriver,
} from "../src/sandbox-controller.js";

const id = "00000000-0000-4000-8000-000000000001";
const session = "sbx_0123456789";
const now = "2026-10-27T12:00:00Z";
function fixture(
	withProxy = false,
	reportFailure: (failure: SandboxLaunchFailure) => void = () => {},
) {
	let lease = create(LeaseSchema, {
		id,
		accountId: "test",
		offerId: "sandbox",
		provider: "vercel",
		jobId: 11,
		originalRunId: 22,
		runAttempt: 1,
		repository: "example/repo",
		repositoryId: 1,
		installationId: 2,
		runnerName: `hobo-${id}`,
		state: "reserved",
		reservedMinutes: 10,
		sandboxPricing: withProxy
			? create(SandboxPricingSchema, { proxyVmRequired: true })
			: undefined,
	});
	const events: string[] = [];
	const pending: ReturnType<typeof create<typeof JobSchema>>[] = [];
	const unreachable = async () => {
		throw new Error("unexpected store operation");
	};
	const store: SandboxLeaseStore = {
		configuration: unreachable,
		policySnapshot: unreachable,
		all: unreachable,
		activeLeases: unreachable,
		accountLeases: unreachable,
		pendingJobs: unreachable,
		observe: unreachable,
		queue: unreachable,
		reserve: unreachable,
		cancelAndRequeue: unreachable,
		settleObserved: unreachable,
		async get() {
			return structuredClone(lease);
		},
		async transition(
			_id: string,
			expected: readonly string[],
			update: (entry: Lease) => void,
			event: string,
			_at: string,
			revision?: number,
		) {
			if (!expected.includes(lease.state)) return undefined;
			if (revision !== undefined && revision !== 1) throw new Error("stale");
			const copy = structuredClone(lease);
			update(copy);
			lease = copy;
			events.push(event);
			return structuredClone(lease);
		},
		async configureSandboxProxy(_account, _id, proxySession, hash) {
			expect(proxySession).toBe("sbx_proxy");
			expect(hash).toMatch(/^[a-f0-9]{64}$/);
			events.push("proxy-quota");
		},
		async configureSandboxEgress(
			_account: string,
			_id: string,
			sandboxId: string,
		) {
			expect(sandboxId).toBe(session);
			events.push("quota");
		},
		async settleSandboxObserved(
			_id: string,
			_at: string,
			_completedAt: string,
			observed: Pick<
				Lease,
				| "state"
				| "runnerId"
				| "actualJobId"
				| "sandboxSessionId"
				| "sandboxCommandId"
				| "sandboxStage"
			>,
			cost: number,
			unmet?: ReturnType<typeof create<typeof JobSchema>>,
		) {
			if (
				lease.state !== observed.state ||
				lease.runnerId !== observed.runnerId ||
				lease.actualJobId !== observed.actualJobId ||
				lease.sandboxSessionId !== observed.sandboxSessionId ||
				lease.sandboxCommandId !== observed.sandboxCommandId ||
				lease.sandboxStage !== observed.sandboxStage
			)
				return undefined;
			lease.state = "completed";
			lease.paidMicros = cost;
			if (unmet) pending.push(unmet);
			return lease;
		},
	};
	const driver: IsolatedSandboxDriver = {
		create: vi.fn(async ({ name }) => {
			events.push("guest-create");
			return {
				name,
				sessionId: session,
				expiresAt: Date.parse(now) + 10 * 60_000,
			};
		}),
		discover: vi.fn(async () => ({ sessionId: session })),
		prepare: vi.fn(async () => {
			expect(events).toContain("quota");
		}),
		start: vi.fn(async (_name, _session, jit) => {
			expect(jit).toBe("b25lLXRpbWU=");
			return { cmdId: "cmd_1" };
		}),
		inspect: vi.fn(async () => ({ commandId: "cmd_1", exitCode: 0 })),
		stop: vi.fn(async () => {
			events.push("guest-stop");
			return {
				cpuMs: 500,
				durationMs: 1000,
				memoryMb: 2048,
				vcpus: 1,
				egressBytes: 100,
				ingressBytes: 0,
				creations: 1,
				stoppedAt: Date.parse(now),
			};
		}),
	};
	const proxyDriver: SandboxProxyDriver = {
		create: vi.fn(async ({ name }) => {
			events.push("proxy-create");
			return {
				name,
				sessionId: "sbx_proxy",
				origin: "https://proxy.example",
				expiresAt: Date.parse(now) + 12 * 60_000,
			};
		}),
		start: vi.fn(async (_name, _session, config) => {
			expect(config.quotaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
			events.push("proxy-start");
			return { commandId: "cmd_proxy" };
		}),
		bind: vi.fn(async (_origin, _token, guest) => {
			expect(guest).toBe(session);
			events.push("proxy-bind");
		}),
		discover: vi.fn(async () => ({ sessionId: "sbx_proxy" })),
		stop: vi.fn(async () => {
			events.push("proxy-stop");
			return {
				cpuMs: 500,
				durationMs: 1000,
				memoryMb: 2048,
				vcpus: 1,
				egressBytes: 100,
				ingressBytes: 50,
				creations: 1,
				stoppedAt: Date.parse(now),
			};
		}),
	};
	const github = {
		request: vi.fn(
			async (_installation: number, _path: string, method?: string) =>
				method === "POST"
					? Response.json(
							{
								runner: { id: 31, name: `hobo-${id}` },
								encoded_jit_config: "b25lLXRpbWU=",
							},
							{ status: 201 },
						)
					: method === "DELETE"
						? new Response(null, { status: 204 })
						: Response.json({ runners: [] }),
		),
	};
	const connection = create(ConnectionSchema, {
		accountId: "test",
		repository: "example/repo",
		repositoryId: 1,
		installationId: 2,
		runnerGroupId: 1,
	});
	const assignment = vi.fn<
		() => Promise<{ kind: "assigned"; jobId: number } | { kind: "unknown" }>
	>(async () => ({ kind: "assigned", jobId: 99 }));
	const controller = createSandboxController({
		store,
		github,
		driver,
		proxyDriver,
		reportFailure,
		authorize: async () => {
			const authority: SandboxAuthority = {
				revision: 1,
				connection,
				maxEgressBytes: 1_000_000,
				configuration: {
					plan: "hobby",
					vcpus: 1,
					forwardUrl: "https://relay.example/proxy",
					allowedDomains: ["github.com"],
				},
			};
			if (withProxy) {
				authority.proxy = {
					extraMs: 120_000,
					create: {
						plan: "hobby",
						region: "iad1",
						vcpus: 1,
						port: 3000,
						relayOrigin: "https://relay.example",
						domains: ["github.com"],
					},
					config: {
						relayOrigin: "https://relay.example",
						expectedIssuer: "https://oidc.vercel.com/team",
						teamId: "team_1",
						projectId: "prj_1",
						hosts: ["github.com"],
						maxEgressBytes: 1000000,
						maxControlCalls: 20,
						port: 3000,
						maxRequestBytes: 1000000,
						maxResponseBytes: 1000000,
					},
				};
			}
			return authority;
		},
		charge: async () => ({ paidMicros: 123 }),
		assignment,
		unmet: async () =>
			create(JobSchema, { id: 11, repositoryId: 1, runId: 22, runAttempt: 1 }),
		now: () => now,
	});
	return {
		store,
		driver,
		proxyDriver,
		github,
		controller,
		assignment,
		events,
		pending,
		read: () => lease,
	};
}
describe("isolated runner lifecycle", () => {
	it("reports the failed phase without exception text and still attempts cleanup", async () => {
		const reportFailure = vi.fn();
		const f = fixture(false, reportFailure);
		vi.mocked(f.driver.prepare).mockRejectedValue(
			new Error("private-jit-and-provider-credential"),
		);
		await f.controller.launch(id);
		expect(reportFailure).toHaveBeenCalledWith({
			leaseId: id,
			phase: "runner_prepare",
		});
		expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(
			"private-jit-and-provider-credential",
		);
		expect(f.driver.stop).toHaveBeenCalled();
	});
	it("reports only numeric GitHub registration status without response text", async () => {
		const reportFailure = vi.fn();
		const f = fixture(false, reportFailure);
		f.github.request.mockImplementation(async (_installation, _path, method) =>
			method === "POST"
				? new Response("sensitive provider response", { status: 403 })
				: Response.json({ runners: [] }),
		);
		await f.controller.launch(id);
		expect(reportFailure).toHaveBeenCalledWith({
			leaseId: id,
			phase: "jit_register",
			status: 403,
		});
		expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(
			"sensitive provider response",
		);
	});
	it("continues cleanup if telemetry itself fails", async () => {
		const f = fixture(false, () => {
			throw new Error("reporting failed");
		});
		vi.mocked(f.driver.prepare).mockRejectedValue(new Error("prepare failed"));
		await f.controller.launch(id);
		expect(f.driver.stop).toHaveBeenCalled();
	});
	it("stops a positively discovered guest before its delayed create response returns", async () => {
		const f = fixture();
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		vi.mocked(f.driver.create).mockImplementation(async ({ name }) => {
			notify();
			await waiting;
			return { name, sessionId: session, expiresAt: Date.parse(now) + 600000 };
		});
		const launching = f.controller.launch(id);
		await reached;
		await f.controller.reconcile(id, true);
		expect(f.read().state).toBe("completed");
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		resume();
		await launching;
		expect(f.read().state).toBe("completed");
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.driver.start).not.toHaveBeenCalled();
		expect(f.github.request).not.toHaveBeenCalled();
		expect(f.pending).toHaveLength(1);
	});
	it("stops a positively discovered proxy before its delayed create response returns", async () => {
		const f = fixture(true);
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		vi.mocked(f.proxyDriver.create).mockImplementation(async ({ name }) => {
			notify();
			await waiting;
			return {
				name,
				sessionId: "sbx_proxy",
				origin: "https://proxy.example",
				expiresAt: Date.parse(now) + 720000,
			};
		});
		const launching = f.controller.launch(id);
		await reached;
		await f.controller.reconcile(id, true);
		expect(f.read().state).toBe("completed");
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
		resume();
		await launching;
		expect(f.read().state).toBe("completed");
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
		expect(f.driver.create).not.toHaveBeenCalled();
		expect(f.github.request).not.toHaveBeenCalled();
		expect(f.pending).toHaveLength(1);
	});
	it("deletes a positively discovered runner before its delayed JIT response returns", async () => {
		const f = fixture();
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		f.github.request.mockImplementation(
			async (_installation, _path, method) => {
				if (method === "POST") {
					notify();
					await waiting;
					return Response.json(
						{
							runner: { id: 31, name: `hobo-${id}` },
							encoded_jit_config: "b25lLXRpbWU=",
						},
						{ status: 201 },
					);
				}
				if (method === "DELETE") return new Response(null, { status: 204 });
				return Response.json({ runners: [{ id: 31, name: `hobo-${id}` }] });
			},
		);
		const launching = f.controller.launch(id);
		await reached;
		await f.controller.reconcile(id, true);
		expect(f.read()).toMatchObject({
			state: "completed",
			runnerDeletionConfirmed: true,
		});
		resume();
		await launching;
		expect(f.read().state).toBe("completed");
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.driver.start).not.toHaveBeenCalled();
		expect(
			f.github.request.mock.calls.filter((call) => call[2] === "DELETE"),
		).toHaveLength(1);
		expect(f.pending).toHaveLength(1);
	});
	it("fences a dispatched launch before registration and force-stops its VM", async () => {
		const f = fixture();
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		vi.mocked(f.driver.prepare).mockImplementation(async () => {
			notify();
			await waiting;
		});
		const launching = f.controller.launch(id);
		await reached;
		expect(f.read().state).toBe("dispatched");
		await f.controller.reconcile(id, true);
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.read().state).toBe("completed");
		resume();
		await launching;
		expect(f.github.request).not.toHaveBeenCalled();
		expect(f.driver.start).not.toHaveBeenCalled();
	});
	it("retains an in-flight create until the VM identity can be found and stopped", async () => {
		const f = fixture();
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		vi.mocked(f.driver.create).mockImplementation(async ({ name }) => {
			notify();
			await waiting;
			return { name, sessionId: session, expiresAt: Date.parse(now) + 600000 };
		});
		vi.mocked(f.driver.discover).mockRejectedValue(
			new Error("not visible yet"),
		);
		const launching = f.controller.launch(id);
		await reached;
		await expect(f.controller.reconcile(id, true)).rejects.toThrow(
			"not visible yet",
		);
		expect(f.read().state).toBe("uncertain");
		expect(f.pending).toHaveLength(0);
		resume();
		await launching;
		expect(f.github.request).not.toHaveBeenCalled();
		vi.mocked(f.driver.discover).mockResolvedValue({ sessionId: session });
		await f.controller.reconcile(id, true);
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.read().state).toBe("completed");
	});
	it("retains an in-flight JIT registration until its runner is found and removed", async () => {
		const f = fixture();
		let resume!: () => void;
		let notify!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			notify = resolve;
		});
		f.github.request.mockImplementation(
			async (_installation, _path, method) => {
				if (method === "POST") {
					notify();
					await waiting;
					return Response.json(
						{
							runner: { id: 31, name: `hobo-${id}` },
							encoded_jit_config: "b25lLXRpbWU=",
						},
						{ status: 201 },
					);
				}
				if (method === "DELETE") return new Response(null, { status: 204 });
				return Response.json({ runners: [] });
			},
		);
		const launching = f.controller.launch(id);
		await reached;
		expect(f.read().state).toBe("claiming");
		await f.controller.reconcile(id, true);
		expect(f.read().state).toBe("uncertain");
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		resume();
		await launching;
		expect(f.driver.start).not.toHaveBeenCalled();
		f.github.request.mockResolvedValueOnce(
			Response.json({ runners: [{ id: 31, name: `hobo-${id}` }] }),
		);
		await f.controller.reconcile(id, true);
		expect(f.read()).toMatchObject({
			state: "completed",
			runnerDeletionConfirmed: true,
		});
	});
	it("fences concurrent launches and registers just one runner", async () => {
		const f = fixture();
		await Promise.all(
			Array.from({ length: 10 }, () => f.controller.launch(id)),
		);
		expect(f.driver.create).toHaveBeenCalledTimes(1);
		expect(f.github.request).toHaveBeenCalledTimes(1);
		expect(f.read()).toMatchObject({
			state: "running",
			runnerId: 31,
			sandboxSessionId: session,
			sandboxCommandId: "cmd_1",
		});
	});
	it("stops and retains budget after a lost JIT response instead of retrying", async () => {
		const f = fixture();
		f.github.request.mockRejectedValueOnce(new Error("connection lost"));
		await f.controller.launch(id);
		await f.controller.launch(id);
		expect(f.read().state).toBe("uncertain");
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.driver.start).not.toHaveBeenCalled();
		expect(f.github.request).toHaveBeenCalledTimes(2);
	});
	it("recovers a registered runner after a lost JIT response and releases its reservation only after deletion", async () => {
		const f = fixture();
		f.github.request.mockRejectedValueOnce(new Error("connection lost"));
		f.github.request.mockResolvedValueOnce(Response.json({ runners: [] }));
		await f.controller.launch(id);
		expect(f.read().state).toBe("uncertain");
		f.github.request.mockResolvedValueOnce(
			Response.json({ runners: [{ id: 31, name: `hobo-${id}` }] }),
		);
		await f.controller.reconcile(id, true);
		expect(f.github.request).toHaveBeenLastCalledWith(
			2,
			"/repos/example/repo/actions/runners/31",
			"DELETE",
		);
		expect(f.read()).toMatchObject({
			state: "completed",
			runnerId: 31,
			runnerDeletionConfirmed: true,
		});
		expect(f.driver.start).not.toHaveBeenCalled();
		expect(f.assignment).not.toHaveBeenCalled();
		expect(f.pending.map((job) => job.id)).toEqual([11]);
	});
	it("retains the reservation if recovery finds duplicate runner names", async () => {
		const f = fixture();
		f.github.request.mockRejectedValueOnce(new Error("connection lost"));
		f.github.request.mockResolvedValueOnce(Response.json({ runners: [] }));
		await f.controller.launch(id);
		f.github.request.mockResolvedValueOnce(
			Response.json({
				runners: [
					{ id: 31, name: `hobo-${id}` },
					{ id: 32, name: `hobo-${id}` },
				],
			}),
		);
		await expect(f.controller.reconcile(id, true)).rejects.toThrow(
			"runner lookup ambiguous",
		);
		expect(f.read().state).toBe("uncertain");
		expect(f.pending).toHaveLength(0);
	});
	it("scans runner pages and retains the reservation when deletion is unconfirmed", async () => {
		const f = fixture();
		f.github.request.mockRejectedValueOnce(new Error("connection lost"));
		f.github.request.mockResolvedValueOnce(Response.json({ runners: [] }));
		await f.controller.launch(id);
		f.github.request.mockResolvedValueOnce(
			Response.json({
				runners: Array.from({ length: 100 }, (_, i) => ({
					id: i + 100,
					name: `other-${i}`,
				})),
			}),
		);
		f.github.request.mockResolvedValueOnce(
			Response.json({ runners: [{ id: 31, name: `hobo-${id}` }] }),
		);
		f.github.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(f.controller.reconcile(id, true)).rejects.toThrow(
			"runner cleanup unconfirmed",
		);
		expect(f.github.request).toHaveBeenCalledWith(
			2,
			"/repos/example/repo/actions/runners?per_page=100&page=2",
		);
		expect(f.read()).toMatchObject({
			state: "uncertain",
			runnerId: 31,
			runnerDeletionConfirmed: false,
		});
		expect(f.pending).toHaveLength(0);
	});
	it("accounts for the actual job and requeues the original when a different job takes the runner", async () => {
		const f = fixture();
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.read()).toMatchObject({
			state: "completed",
			actualJobId: 99,
			paidMicros: 123,
		});
		expect(f.pending.map((entry) => entry.id)).toEqual([11]);
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
	});
	it("settles measured usage without asserting that an unknown runner was idle", async () => {
		const f = fixture(true);
		f.assignment.mockResolvedValue({ kind: "unknown" });
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.read()).toMatchObject({
			state: "completed",
			actualJobId: 0,
			paidMicros: 123,
			sandboxStage: "stopped",
			proxySandboxStage: "stopped",
			runnerDeletionConfirmed: true,
		});
	});
	it("does not settle if assignment arrives after the observation", async () => {
		const f = fixture(true);
		f.assignment.mockResolvedValue({ kind: "unknown" });
		const settle = f.store.settleSandboxObserved.bind(f.store);
		f.store.settleSandboxObserved = async (...args) => {
			await f.store.transition(
				id,
				["running"],
				(lease) => {
					lease.actualJobId = 98;
				},
				"ci.JobObserved",
				now,
			);
			return settle(...args);
		};
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.read()).toMatchObject({ state: "running", actualJobId: 98 });
	});
	it("discovers a VM after a lost create response, stops it and accounts before releasing budget", async () => {
		const f = fixture();
		vi.mocked(f.driver.create).mockRejectedValueOnce(
			new Error("response lost"),
		);
		vi.mocked(f.driver.discover).mockRejectedValueOnce(
			new Error("lookup delayed"),
		);
		await f.controller.launch(id);
		expect(f.read()).toMatchObject({
			state: "uncertain",
			sandboxStage: "creating",
			sandboxSessionId: "",
		});
		await f.controller.reconcile(id, true);
		expect(f.driver.discover).toHaveBeenCalledTimes(2);
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.read()).toMatchObject({
			state: "completed",
			paidMicros: 123,
			sandboxSessionId: session,
		});
		expect(f.github.request).not.toHaveBeenCalled();
		expect(f.pending.map((job) => job.id)).toEqual([11]);
	});
	it("observes assignment only after VM stop, covering assignment during shutdown", async () => {
		const f = fixture();
		f.assignment.mockImplementation(async () => {
			expect(f.driver.stop).toHaveBeenCalled();
			return { kind: "assigned", jobId: 99 };
		});
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.read()).toMatchObject({ state: "completed", actualJobId: 99 });
	});
	it("cleans up a VM that auto-stopped before command inspection", async () => {
		const f = fixture();
		vi.mocked(f.driver.inspect).mockResolvedValueOnce({
			commandId: "cmd_1",
			exitCode: null,
			terminal: true,
		});
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.driver.stop).toHaveBeenCalledOnce();
		expect(f.read().state).toBe("completed");
	});
	it("retains budget if final usage cannot be confirmed after stopping", async () => {
		const f = fixture();
		vi.mocked(f.driver.stop).mockRejectedValueOnce(
			new Error("usage unavailable"),
		);
		await f.controller.launch(id);
		await expect(f.controller.reconcile(id)).rejects.toThrow();
		expect(f.read().state).toBe("running");
		expect(f.pending).toHaveLength(0);
	});
	it("creates the proxy first, binds the guest, and stops both before accounting", async () => {
		const f = fixture(true);
		await f.controller.launch(id);
		expect(f.read()).toMatchObject({
			state: "running",
			proxySandboxSessionId: "sbx_proxy",
			proxySandboxStage: "running",
			sandboxSessionId: session,
		});
		expect(f.events.indexOf("proxy-start")).toBeLessThan(
			f.events.indexOf("guest-create"),
		);
		expect(f.events.indexOf("quota")).toBeLessThan(
			f.events.indexOf("proxy-bind"),
		);
		await f.controller.reconcile(id);
		expect(f.read()).toMatchObject({
			state: "completed",
			sandboxStage: "stopped",
			proxySandboxStage: "stopped",
			runnerDeletionConfirmed: true,
		});
		expect(f.events.indexOf("guest-stop")).toBeLessThan(
			f.events.indexOf("proxy-stop"),
		);
	});
	it("stops and accounts the proxy alone if startup fails before guest creation", async () => {
		const f = fixture(true);
		vi.mocked(f.proxyDriver.start).mockRejectedValueOnce(
			new Error("lost proxy start"),
		);
		await f.controller.launch(id);
		expect(f.driver.create).not.toHaveBeenCalled();
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
		expect(f.read()).toMatchObject({
			state: "completed",
			sandboxStage: "pending",
			proxySandboxStage: "stopped",
		});
		expect(f.github.request).not.toHaveBeenCalled();
	});
	it("never registers a guest whose delayed creation would outlive the proxy", async () => {
		const f = fixture(true);
		vi.mocked(f.driver.create).mockImplementationOnce(async ({ name }) => ({
			name,
			sessionId: session,
			expiresAt: Date.parse(now) + 12 * 60_000,
		}));
		await f.controller.launch(id);
		expect(f.github.request).not.toHaveBeenCalled();
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
	});
	it("stops the known proxy while an ambiguous guest creation remains unresolved", async () => {
		const f = fixture(true);
		vi.mocked(f.driver.create).mockRejectedValueOnce(
			new Error("lost guest create"),
		);
		vi.mocked(f.driver.discover).mockRejectedValueOnce(
			new Error("guest not yet visible"),
		);
		await f.controller.launch(id);
		expect(f.read()).toMatchObject({
			state: "uncertain",
			sandboxStage: "creating",
			proxySandboxStage: "stopped",
		});
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
		expect(f.pending).toHaveLength(0);
		await f.controller.reconcile(id, true);
		expect(f.driver.stop).toHaveBeenCalledTimes(1);
		expect(f.read()).toMatchObject({
			state: "completed",
			sandboxStage: "stopped",
			proxySandboxStage: "stopped",
		});
		expect(f.proxyDriver.stop).toHaveBeenCalledTimes(1);
	});
	it("holds the proxy and budget if guest termination cannot be verified", async () => {
		const f = fixture(true);
		await f.controller.launch(id);
		vi.mocked(f.driver.stop).mockRejectedValueOnce(
			new Error("unknown guest stop"),
		);
		await expect(f.controller.reconcile(id)).rejects.toThrow();
		expect(f.read()).toMatchObject({
			state: "running",
			sandboxStage: "stopping",
			proxySandboxStage: "running",
		});
		expect(f.proxyDriver.stop).not.toHaveBeenCalled();
	});
	it("keeps a live runner reserved until its command terminates", async () => {
		const f = fixture();
		vi.mocked(f.driver.inspect).mockResolvedValueOnce({
			commandId: "cmd_1",
			exitCode: null,
		});
		await f.controller.launch(id);
		await f.controller.reconcile(id);
		expect(f.read().state).toBe("running");
		expect(f.driver.stop).not.toHaveBeenCalled();
	});
});
