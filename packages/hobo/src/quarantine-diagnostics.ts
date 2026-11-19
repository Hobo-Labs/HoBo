import { toJson } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type EventStore,
	parseEventPosition,
} from "@hobo/core";
import { QuarantineReportSchema, readQuarantineReport } from "@hobo/data";

function hasJournalReader(
	store: EventStore,
): store is EventStore & Pick<DurableEventStore, "readAll"> {
	return "readAll" in store && store.readAll instanceof Function;
}

export async function quarantineDiagnostics(
	store: EventStore | undefined,
	tenant: string,
	after?: string,
) {
	if (!store || !hasJournalReader(store)) {
		return {
			available: false as const,
			reason: "The event store does not provide an ordered journal.",
		};
	}
	try {
		const report = await readQuarantineReport({
			store,
			tenant,
			...(after === undefined
				? undefined
				: { after: parseEventPosition(after) }),
		});
		return {
			available: true as const,
			report,
			json: toJson(QuarantineReportSchema, report, {
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
