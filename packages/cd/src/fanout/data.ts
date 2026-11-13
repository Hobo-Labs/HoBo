// Which of a Camp's resources hold data (D21 departure, D23 failover-unsafe).
// Pure. A resource is data when its plan port is a data port, or when the
// reconciler observed it with a data classification or a data kind. Unknown
// ports are compute; anything the reconciler classified is data (fail closed:
// a classified resource is never treated as movable compute).
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { ReconcileObservationRecord } from "../_generated/cd_pb.js";

// public-contract: plan ports whose resources hold data and never move (D23).
export const DATA_PORTS: ReadonlySet<string> = new Set([
	"database",
	"db",
	"sql",
	"postgres",
	"mysql",
	"kv",
	"cache",
	"queue",
	"stream",
	"topic",
	"object-store",
	"objectstore",
	"blob",
	"bucket",
	"storage",
	"volume",
	"data",
	"search",
	"vector",
]);

export function isDataPort(port: string): boolean {
	const bare = port.startsWith("hobo:") ? port.slice("hobo:".length) : port;
	return DATA_PORTS.has(bare.toLowerCase());
}

export function dataResourcesOf(
	resolved: ResolvedDeploymentSet | undefined,
	observed: ReconcileObservationRecord | undefined,
): string[] {
	const out = new Set<string>();
	for (const resource of resolved?.plan.resources ?? [])
		if (isDataPort(resource.port)) out.add(resource.name);
	for (const resource of observed?.resources ?? [])
		if (resource.classification !== "" || isDataPort(resource.kind))
			out.add(resource.resource);
	return [...out].sort();
}
