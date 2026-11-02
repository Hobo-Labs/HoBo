import type { HostedRelayStore, IsolatedRunnerHost } from "../hosted-relay.js";

/** Route launch/reconcile to the provider that owns the lease. */
export function createCompositeIsolatedHost(options: {
	store: Pick<HostedRelayStore, "get">;
	sandbox?: IsolatedRunnerHost;
	worker?: IsolatedRunnerHost;
}): IsolatedRunnerHost | undefined {
	if (!options.sandbox && !options.worker) return undefined;
	return {
		async launch(id: string) {
			const lease = await options.store.get(id);
			if (!lease) return;
			if (lease.provider === "vercel") await options.sandbox?.launch(id);
			else if (
				lease.provider === "kubernetes" ||
				lease.provider === "hobo-box-worker"
			)
				await options.worker?.launch(id);
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
