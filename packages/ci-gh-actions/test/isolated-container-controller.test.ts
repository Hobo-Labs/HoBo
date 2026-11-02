import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { PostgresCiStore } from "@hobo/ci/postgres";
import type { GithubTransport } from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import { NOW } from "./fixtures.js";

describe("isolated container controller reconcile", () => {
	it("requeues uncertain leases without a container session after the recovery timeout", async () => {
		const stuck = create(LeaseSchema, {
			id: "00000000-0000-4000-8000-000000000001",
			accountId: "account-a",
			provider: "kubernetes",
			repository: "org/repo",
			repositoryId: 101,
			installationId: 10,
			jobId: 1,
			originalRunId: 11,
			runAttempt: 1,
			runnerName: "hobo-00000000-0000-4000-8000-000000000001",
			state: "uncertain",
			createdAt: NOW,
		});
		const abort = vi.fn(async () => {});
		// SAFETY: reconcile() only calls get() and abortIsolatedAndRequeue(); this stub implements both.
		const relayStore = {
			get: async (id: string) => (id === stuck.id ? stuck : undefined),
			abortIsolatedAndRequeue: abort,
		} as PostgresCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
		};
		// SAFETY: reconcile() does not call github in this scenario.
		const github = {} as GithubTransport;
		const early = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			uncertainWithoutContainerRecoveryMs: 60_000,
			now: () => "2026-10-26T12:00:30Z",
		});
		await early.host.reconcile(stuck.id, true);
		expect(abort).not.toHaveBeenCalled();
		const late = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			uncertainWithoutContainerRecoveryMs: 60_000,
			now: () => "2026-10-26T12:01:01Z",
		});
		await late.host.reconcile(stuck.id, true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(abort.mock.calls[0]?.[1]).toMatchObject({
			labels: ["hobo"],
			isolatedRequired: true,
		});
	});
});
