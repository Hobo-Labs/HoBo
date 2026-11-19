import type { ManifestV1 } from "@hobo/bindles";
import type {
	HostingPlanCommitment,
	HostingPlanningInput,
} from "../planner/hosting-budget.js";

export interface HostingReservationIdentity {
	readonly reservationId: string;
	readonly tenantId: string;
	readonly commitmentHash: string;
}

export interface SharedHostingBudgetAuthority {
	readonly persistence: "durable-cas";
	readonly resolve?: (request: {
		budgetId: string;
		tenantId: string;
		bindle: ManifestV1;
		objective: string;
		intent?: "deploy" | "decommission";
		sourcePlanId?: string;
		sourceIncarnationId?: string;
	}) => Promise<HostingPlanningInput>;
	reserve(request: {
		reservationId: string;
		planHash: string;
		commitment: HostingPlanCommitment;
	}): Promise<
		{ ok: true; reservationId: string } | { ok: false; reason: string }
	>;
	lookup(request: HostingReservationIdentity): Promise<{
		status: "held" | "uncertain" | "settled" | "missing";
		reservedMicros: number;
		commitmentHash?: string;
		settledMicros?: number;
		financialPlanHash?: string;
		executionDigest?: string;
	}>;
	claimExecution(
		request: HostingReservationIdentity & {
			financialPlanHash: string;
			executionDigest: string;
		},
	): Promise<{ ok: true } | { ok: false; reason: string }>;
	uncertain(
		request: HostingReservationIdentity & { reason: string },
	): Promise<void>;
	settle(
		request: HostingReservationIdentity & {
			settledMicros: number;
			evidenceRef: string;
			sourceStoppedEvidenceRef: string;
		},
	): Promise<{ ok: true } | { ok: false; reason: string }>;
}
