import type { ResourceLifecycleObservation, RoutingPlan } from "@hobo/core";
import { encodesPathSeparator } from "@hobo/core";

function endpoint(value: string, allowInsecureLoopback: boolean) {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		encodesPathSeparator(url.pathname) ||
		(url.protocol !== "https:" &&
			!(
				allowInsecureLoopback &&
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error(
			"native serving and health endpoints require HTTPS without credentials, query or fragment",
		);
	return url;
}
/** Match native readback to the exact active Station backends, then require an
 * independently configured health probe under each routed native endpoint. */
export function assertHostingServingEndpoints(input: {
	readonly observations: readonly ResourceLifecycleObservation[];
	readonly routing: RoutingPlan;
	readonly healthUrls: readonly string[];
	readonly allowInsecureLoopback?: boolean;
}) {
	const allow = input.allowInsecureLoopback === true;
	const native = new Set(
		input.observations
			.filter(
				(row) =>
					row.status === "ready" &&
					row.operationTerminal &&
					row.servingEndpoint,
			)
			.map((row) => endpoint(row.servingEndpoint, allow).href),
	);
	const active = new Set<string>();
	for (const rule of input.routing.intent.rules)
		for (const backend of rule.backends) {
			if (backend.weight === 0) continue;
			if (!backend.endpoint)
				throw new Error(
					"active Station backend has no independently observed native serving endpoint",
				);
			const value = endpoint(backend.endpoint, allow).href;
			if (!native.has(value))
				throw new Error(
					"Station backend does not match an independently observed native serving endpoint",
				);
			active.add(value);
		}
	if (!active.size)
		throw new Error("hosting route has no active native serving endpoint");
	const covered = new Set<string>();
	const probes = input.healthUrls.map((value) => {
		const probe = endpoint(value, allow);
		const matches = [...active]
			.filter((item) => {
				const base = new URL(item),
					prefix = base.pathname.replace(/\/$/u, "");
				return (
					probe.origin === base.origin &&
					(probe.pathname === base.pathname ||
						probe.pathname.startsWith(`${prefix}/`))
				);
			})
			.sort((a, b) => new URL(b).pathname.length - new URL(a).pathname.length);
		const match = matches[0];
		if (!match)
			throw new Error(
				"health probe does not belong to an active native Station backend",
			);
		if (covered.has(match))
			throw new Error(
				"duplicate health probes do not cover another native backend",
			);
		covered.add(match);
		return probe.href;
	});
	if (covered.size !== active.size)
		throw new Error(
			"every active native Station backend requires an independent health probe",
		);
	return probes;
}
