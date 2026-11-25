import { clone, toJsonString } from "@bufbuild/protobuf";
import { type Lease, LeaseSchema } from "./_generated/ci_pb.js";

/** Only monotonic, session-bound retirement bookkeeping may outlive admission. */
export function isIsolatedRetirementTransition(
	before: Lease,
	after: Lease,
	type: string,
	at: string,
): boolean {
	if (
		before.pipelineId ||
		!["kubernetes", "hobo-box-worker"].includes(before.provider) ||
		!["dispatching", "dispatched", "claiming", "running", "uncertain"].includes(
			before.state,
		) ||
		before.sandboxName !== `hobo-${before.id}` ||
		!before.sandboxSessionId ||
		!Number.isFinite(Date.parse(at)) ||
		!Number.isFinite(Date.parse(before.createdAt)) ||
		Date.parse(at) < Date.parse(before.createdAt)
	)
		return false;
	const stageChange =
		type === "ci.SandboxStopRequested" &&
		["created", "registering", "starting", "running"].includes(
			before.sandboxStage,
		) &&
		after.sandboxStage === "stopping" &&
		!before.usageCompletedAt &&
		!after.usageCompletedAt;
	const stopped =
		type === "ci.SandboxStopped" &&
		before.sandboxStage === "stopping" &&
		after.sandboxStage === "stopped" &&
		!before.usageCompletedAt &&
		!after.usageCompletedAt;
	const removed =
		type === "ci.SandboxRemoved" &&
		before.sandboxStage === "stopped" &&
		after.sandboxStage === "stopped" &&
		!before.usageCompletedAt &&
		after.usageCompletedAt === at;
	if (!stageChange && !stopped && !removed) return false;
	const normalized = clone(LeaseSchema, after);
	normalized.sandboxStage = before.sandboxStage;
	normalized.usageCompletedAt = before.usageCompletedAt;
	return (
		toJsonString(LeaseSchema, normalized) === toJsonString(LeaseSchema, before)
	);
}
