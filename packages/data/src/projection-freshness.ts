export function initialReplicaFreshness() {
	return {
		checkedAtMs: null as number | null,
		firstIncompleteAtMs: null as number | null,
		lastCheckpointAtMs: null as number | null,
	};
}

type ReplicaFreshness = ReturnType<typeof initialReplicaFreshness>;

export function checkpointReplicaFreshness(
	previous: ReplicaFreshness,
	checkedAtMs: number,
	caughtUp: boolean,
): ReplicaFreshness {
	if (
		previous.lastCheckpointAtMs !== null &&
		checkedAtMs < previous.lastCheckpointAtMs
	)
		throw new Error("replica checkpoint clock moved backward");
	return {
		checkedAtMs: caughtUp ? checkedAtMs : previous.checkedAtMs,
		firstIncompleteAtMs:
			caughtUp || previous.checkedAtMs !== null
				? null
				: (previous.firstIncompleteAtMs ?? checkedAtMs),
		lastCheckpointAtMs: checkedAtMs,
	};
}

export function replicaStaleness(
	freshness: ReplicaFreshness,
	nowMs: number,
	boundMs: number,
) {
	if (
		freshness.lastCheckpointAtMs !== null &&
		nowMs < freshness.lastCheckpointAtMs
	)
		throw new Error("replica clock moved backward");
	const lagSinceMs = freshness.checkedAtMs ?? freshness.firstIncompleteAtMs;
	const elapsed = lagSinceMs === null ? null : nowMs - lagSinceMs;
	const status =
		elapsed !== null && elapsed > boundMs
			? ("exceeds-bound" as const)
			: freshness.checkedAtMs !== null
				? ("within-bound" as const)
				: ("unknown" as const);
	return {
		status,
		checkedAtMs: freshness.checkedAtMs,
		lagSinceMs,
		observedLagMs: status === "unknown" ? null : elapsed,
	};
}
