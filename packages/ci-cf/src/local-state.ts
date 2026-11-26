import { clone, create } from "@bufbuild/protobuf";
import {
	type LocalRunEvent,
	type LocalRunState,
	LocalRunStateSchema,
} from "./_generated/readiness_pb.js";

export function initialLocalState(): LocalRunState {
	return create(LocalRunStateSchema, { phase: "new" });
}

/** The production controller and exhaustive safety proof share this transition function. */
export function transitionLocalRun(
	state: LocalRunState,
	event: LocalRunEvent,
): LocalRunState {
	if (state.phase === "finished") return state;
	const next = clone(LocalRunStateSchema, state);
	switch (event.kind) {
		case "ready":
			if (next.phase !== "new") throw new Error("runtime already admitted");
			next.phase = "ready";
			break;
		case "submitted":
			if (next.phase !== "ready")
				throw new Error("workflow requires a verified runtime");
			next.phase = "running";
			break;
		case "result":
			if (
				next.phase !== "running" ||
				![
					"succeeded",
					"failed",
					"cancelled",
					"timed_out",
					"uncertain",
				].includes(event.status)
			)
				throw new Error("invalid verified pipeline result transition");
			if (next.resultStatus && next.resultStatus !== event.status) {
				next.stopReason = "fault";
				next.phase = "stopping";
			} else next.resultStatus = event.status;
			break;
		case "terminal":
			if (
				next.phase !== "running" ||
				!["complete", "errored", "terminated"].includes(event.status)
			)
				throw new Error("invalid native terminal transition");
			next.workflowStatus = event.status;
			next.phase = "stopping";
			break;
		case "cancelled":
		case "timed_out":
		case "fault":
			if (!next.stopReason) next.stopReason = event.kind;
			next.phase = "stopping";
			break;
		case "shutdown":
		case "shutdown_failed": {
			if (next.phase !== "stopping")
				throw new Error("shutdown requires stopped admission");
			next.shutdownConfirmed = event.kind === "shutdown";
			next.phase = "finished";
			const succeeded =
				next.shutdownConfirmed &&
				!next.stopReason &&
				next.resultStatus === "succeeded" &&
				next.workflowStatus === "complete";
			next.outcome = succeeded
				? "succeeded"
				: !next.shutdownConfirmed || next.stopReason === "fault"
					? "uncertain"
					: next.stopReason === "cancelled"
						? "cancelled"
						: next.stopReason === "timed_out"
							? "timed_out"
							: next.resultStatus === "failed" &&
									next.workflowStatus === "errored"
								? "failed"
								: "uncertain";
			next.exitCode =
				next.outcome === "succeeded"
					? 0
					: next.outcome === "cancelled"
						? 130
						: next.outcome === "timed_out"
							? 124
							: next.outcome === "failed"
								? 1
								: 2;
			break;
		}
		default:
			throw new Error("unknown local run event");
	}
	return next;
}
