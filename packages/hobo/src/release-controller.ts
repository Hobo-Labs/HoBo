export interface ReleaseCandidate {
	readonly deploymentId: string;
	readonly commit: string;
	readonly ready: boolean;
	readonly staged: boolean;
}

export interface ReleaseProvider {
	inspect(deploymentId: string): Promise<ReleaseCandidate>;
	canRollback(deploymentId: string): Promise<boolean>;
	current(): Promise<string>;
	promote(deploymentId: string): Promise<void>;
	rollback(deploymentId: string): Promise<void>;
	probe(commit: string): Promise<boolean>;
}

export interface ReleaseCheckpoint {
	readonly deploymentId: string;
	readonly previousDeploymentId: string;
	readonly commit: string;
	readonly state: "reserved" | "verified" | "rolled-back";
}

export interface ReleaseJournal {
	load(): Promise<ReleaseCheckpoint | undefined>;

	reserve(checkpoint: ReleaseCheckpoint): Promise<{
		readonly checkpoint: ReleaseCheckpoint;
		readonly created: boolean;
	}>;
	save(checkpoint: ReleaseCheckpoint): Promise<void>;
}

export type ReleaseOutcome =
	| Readonly<{ ok: true; previousDeploymentId: string }>
	| Readonly<{
			ok: false;
			code:
				| "candidate-invalid"
				| "journal-failed"
				| "concurrent-change"
				| "promote-failed"
				| "promotion-uncertain"
				| "verification-failed"
				| "rollback-failed";
			rolledBack: boolean;
	  }>;

export async function promoteVerifiedRelease(input: {
	readonly provider: ReleaseProvider;
	readonly journal: ReleaseJournal;
	readonly deploymentId: string;
	readonly commit: string;
	readonly deadline: number;

	readonly rollbackDeadline?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly intervalMs?: number;
	readonly requiredObservations?: number;
}): Promise<ReleaseOutcome> {
	const { provider, journal, deploymentId, commit } = input;
	const now = input.now ?? Date.now;
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const interval = input.intervalMs ?? 10_000;
	const required = input.requiredObservations ?? 3;
	const rollbackDeadline = input.rollbackDeadline ?? input.deadline;
	const fail = (
		code: Exclude<ReleaseOutcome, { ok: true }>["code"],
		rolledBack = false,
	): ReleaseOutcome => ({ ok: false, code, rolledBack });
	if (
		!/^[0-9a-f]{40}$/u.test(commit) ||
		deploymentId === "" ||
		!Number.isSafeInteger(input.deadline) ||
		!Number.isSafeInteger(rollbackDeadline) ||
		rollbackDeadline < input.deadline ||
		!Number.isSafeInteger(interval) ||
		interval < 1 ||
		!Number.isSafeInteger(required) ||
		required < 1 ||
		now() >= input.deadline
	)
		return fail("candidate-invalid");
	try {
		const candidate = await provider.inspect(deploymentId);
		if (
			candidate.deploymentId !== deploymentId ||
			candidate.commit !== commit ||
			!candidate.ready ||
			!candidate.staged
		)
			return fail("candidate-invalid");
	} catch {
		return fail("candidate-invalid");
	}

	let checkpoint: ReleaseCheckpoint | undefined;
	let current: string;
	let newReservation = false;
	try {
		checkpoint = await journal.load();
		current = await provider.current();
		if (checkpoint === undefined) {
			if (current === "" || current === deploymentId)
				return fail("candidate-invalid");
			const reserved = await journal.reserve({
				deploymentId,
				previousDeploymentId: current,
				commit,
				state: "reserved",
			});
			checkpoint = reserved.checkpoint;
			newReservation = reserved.created;
		}
		if (
			checkpoint.deploymentId !== deploymentId ||
			checkpoint.commit !== commit ||
			checkpoint.previousDeploymentId === "" ||
			checkpoint.previousDeploymentId === deploymentId ||
			checkpoint.state === "rolled-back"
		) {
			return fail("journal-failed");
		}
	} catch {
		return fail("journal-failed");
	}
	const reservation = checkpoint;
	const previous = reservation.previousDeploymentId;
	try {
		if (!(await provider.canRollback(previous)))
			return fail("candidate-invalid");
	} catch {
		return fail("candidate-invalid");
	}
	if (reservation.state === "verified" && current !== deploymentId)
		return fail("concurrent-change");
	if (current !== previous && current !== deploymentId)
		return fail("concurrent-change");

	const rollback = async (
		reason: "promote-failed" | "verification-failed" | "journal-failed",
	): Promise<ReleaseOutcome> => {
		try {
			const owner = await provider.current();
			if (owner === previous) return fail("promotion-uncertain");
			if (owner !== deploymentId) return fail("concurrent-change");
			await provider.rollback(previous);
			let confirmed = false;
			let passes =
				Math.ceil(Math.max(0, rollbackDeadline - now()) / interval) + 1;
			while (passes-- > 0) {
				const observed = await provider.current();
				if (observed === previous) {
					confirmed = true;
					break;
				}
				if (observed !== deploymentId) return fail("concurrent-change");
				if (now() + interval >= rollbackDeadline) break;
				await sleep(interval);
			}
			if (!confirmed) return fail("rollback-failed");
			try {
				await journal.save({ ...reservation, state: "rolled-back" });
			} catch {
				return fail("journal-failed", true);
			}
			return fail(reason, true);
		} catch {
			return fail("rollback-failed");
		}
	};

	let promotionFailed = false;
	if (current === previous && newReservation) {
		try {
			if ((await provider.current()) !== previous)
				return fail("concurrent-change");
			await provider.promote(deploymentId);
		} catch {
			promotionFailed = true;
		}
	}
	let successes = 0;
	let passes = Math.ceil(Math.max(0, input.deadline - now()) / interval) + 1;
	while (passes-- > 0 && now() < input.deadline) {
		try {
			const owner = await provider.current();
			if (owner !== previous && owner !== deploymentId)
				return fail("concurrent-change");
			if (owner === deploymentId && promotionFailed)
				return rollback("promote-failed");
			if (owner === deploymentId && (await provider.probe(commit))) successes++;
			else successes = 0;
			if (successes >= required) {
				if ((await provider.current()) !== deploymentId)
					return fail("concurrent-change");
				try {
					await journal.save({ ...reservation, state: "verified" });
				} catch {
					return rollback("journal-failed");
				}
				return { ok: true, previousDeploymentId: previous };
			}
		} catch {
			successes = 0;
		}
		if (now() + interval >= input.deadline) break;
		await sleep(interval);
	}
	return rollback(promotionFailed ? "promote-failed" : "verification-failed");
}
