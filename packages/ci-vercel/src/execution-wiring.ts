import type { IsolatedRunnerHost } from "@hobo/ci-gh-actions";

type RelayBinding = { denyUnisolated: true; isolatedHost?: IsolatedRunnerHost };
type RuntimeBinding = RelayBinding & {
	isolatedRecoveryHost?: Pick<IsolatedRunnerHost, "reconcile">;
};

/** The production runtime uses a separate, identity-bound proxy VM. The
 * legacy direct Function proxy must not perform unbounded issuer discovery. */
export function denyDirectSandboxEgress(
	request: Request,
): Response | undefined {
	const pathname = new URL(request.url).pathname;
	if (pathname === "/sandbox/egress" || pathname.startsWith("/sandbox/egress/"))
		return new Response(null, { status: 404 });
	return undefined;
}

/** One opt-in host is shared by admission, dispatch and repair. */
export function isolatedExecutionWiring(host?: IsolatedRunnerHost) {
	const relay: RelayBinding = {
		denyUnisolated: true,
	};
	const runtime: RuntimeBinding = { denyUnisolated: true };
	if (host) {
		relay.isolatedHost = host;
		runtime.isolatedHost = host;
		runtime.isolatedRecoveryHost = host;
	}
	return {
		relay,
		runtime,
		async ready(
			checkRuntime: () => Promise<boolean>,
			checkWorker: () => Promise<boolean>,
		) {
			return !!host && (await checkRuntime()) && (await checkWorker());
		},
	};
}
