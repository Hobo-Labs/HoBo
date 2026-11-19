import { toJson } from "@bufbuild/protobuf";
import type { DurableEventStore, EventStore } from "@hobo/core";
import {
	ProjectionReplicaReportSchema,
	readProjectionReplicaReport,
} from "@hobo/data";

function hasJournalReader(
	store: EventStore,
): store is EventStore & Pick<DurableEventStore, "readAll"> {
	return "readAll" in store && store.readAll instanceof Function;
}

export async function projectionDiagnostics(
	store: EventStore | undefined,
	tenant: string,
	nowMs?: () => number,
) {
	if (!store || !hasJournalReader(store)) {
		return {
			available: false as const,
			reason: "The event store does not provide an ordered journal.",
		};
	}
	try {
		const report = await readProjectionReplicaReport({
			store,
			tenant,
			...(nowMs ? { nowMs } : undefined),
		});
		return {
			available: true as const,
			report,
			json: toJson(ProjectionReplicaReportSchema, report, {
				alwaysEmitImplicit: true,
			}),
		};
	} catch (error) {
		return {
			available: false as const,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function buildProjectionDoctorSection(
	store: EventStore | undefined,
	tenant: string,
	emitProgress: (message: string) => void,
	nowMs?: () => number,
) {
	const diagnostic = await projectionDiagnostics(store, tenant, nowMs);
	const remediation: string[] = [];
	if (diagnostic.available) {
		for (const replica of diagnostic.report.replicas) {
			for (const read of replica.supportedReads) {
				const staleness =
					read.source === "replica"
						? `, ${replica.stalenessStatus}${replica.observedLagMs === undefined ? "" : ` (${replica.observedLagMs}ms / ${replica.boundMs}ms)`}`
						: "";
				emitProgress(
					`projection ${replica.projection} ${read.source}/${read.readClass}${staleness}`,
				);
			}
			if (replica.missingLagSignal) {
				emitProgress(
					`projection ${replica.projection} has exceeded its lag bound without a lag signal.`,
				);
				remediation.push(
					`Inspect replica ${replica.replicaStreamId} and its lag reporting.`,
				);
			}
		}
	} else if (store) {
		emitProgress(`Projection report unavailable: ${diagnostic.reason}`);
		remediation.push(
			"Inspect the projection report failure and rerun hobo doctor.",
		);
	}
	return { diagnostic, remediation };
}
