import { create } from "@bufbuild/protobuf";
import { JobSchema } from "@hobo/ci";
import type { HostedRelayStore, IsolatedRunnerHost } from "../hosted-relay.js";
import type { RunnerLabel } from "../runner-labels.js";

/** Route launch/reconcile to the provider that owns the lease. */
export function createCompositeIsolatedHost(options: {
	store: Pick<HostedRelayStore, "get">;
	sandbox?: IsolatedRunnerHost;
	worker?: IsolatedRunnerHost;
}): IsolatedRunnerHost | undefined {
	if (!options.sandbox && !options.worker) return undefined;
	return {
		async isLaunchParked(job) {
			if (await options.worker?.isLaunchParked?.(job)) return true;
			if (await options.sandbox?.isLaunchParked?.(job)) return true;
			return false;
		},
		async launch(id: string, label?: RunnerLabel, rank?: number) {
			const lease = await options.store.get(id);
			if (!lease) return;
			const demand = create(JobSchema, {
				id: lease.jobId,
				runId: lease.originalRunId,
				runAttempt: lease.runAttempt,
				repositoryId: lease.repositoryId,
				repository: lease.repository,
				installationId: lease.installationId,
				labels: ["hobo"],
				action: "queued",
				memoryClass: lease.memoryClass,
				memoryMb: lease.memoryMb,
			});
			if (await options.worker?.isLaunchParked?.(demand)) return;
			if (await options.sandbox?.isLaunchParked?.(demand)) return;
			if (lease.provider === "vercel")
				await options.sandbox?.launch(id, label, rank);
			else if (
				lease.provider === "kubernetes" ||
				lease.provider === "hobo-box-worker"
			)
				await options.worker?.launch(id, label, rank);
			else throw new Error("unsupported isolated provider");
		},
		async reconcile(id: string, forceStop?: boolean) {
			const lease = await options.store.get(id);
			if (!lease) return;
			if (lease.provider === "vercel")
				await options.sandbox?.reconcile(id, forceStop);
			else if (
				lease.provider === "kubernetes" ||
				lease.provider === "hobo-box-worker"
			)
				await options.worker?.reconcile(id, forceStop);
		},
	};
}
