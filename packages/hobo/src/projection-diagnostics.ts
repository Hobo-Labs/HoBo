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
