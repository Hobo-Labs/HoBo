/** Persistent evidence that independently scheduled work and the queue are running. */
export interface WorkerHealth {
	mark(component: "queue" | "schedule" | "repair", ok: boolean): Promise<void>;
	ready(): Promise<boolean>;
}

type FailureStage =
	| "tick"
	| "repair"
	| "repair-database"
	| "repair-claims"
	| "repair-scanner";

interface WorkerFailureEvent {
	event: "hobo_ci_worker_failure";
	stage: FailureStage;
	scanner?: number;
	status?: number;
}

/** Log only fixed operation names and an allowlisted numeric GitHub status.
 * Exception text can contain database URLs, credentials, or webhook data. */
export function reportWorkerFailure(
	stage: FailureStage,
	error?: Error,
	scanner?: number,
) {
	const event: WorkerFailureEvent = {
		event: "hobo_ci_worker_failure",
		stage,
	};
	if (
		scanner !== undefined &&
		Number.isSafeInteger(scanner) &&
		scanner >= 0 &&
		scanner <= 9
	)
		event.scanner = scanner;
	if (error instanceof Error) {
		const match = /^GitHub deliveries lookup failed \((\d{3})\)$/.exec(
			error.message,
		);
		if (match?.[1]) {
			const status = Number(match[1]);
			if (status >= 100 && status <= 599) event.status = status;
		}
	}
	try {
		console.error(JSON.stringify(event));
	} catch {
		// Telemetry must never change repair, cleanup, or queue behavior.
	}
}

/** Preserve the original failure while recording only a fixed operation name. */
export async function withRepairStage<T>(
	stage: "repair-database" | "repair-claims",
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		reportWorkerFailure(stage, error instanceof Error ? error : undefined);
		throw error;
	}
}

/** Wakeups and scheduled repair share idempotent, durable application state. */
export function createHostedWorker(options: {
	tick(): Promise<void>;
	repair(): Promise<{
		truncated: boolean;
		more: boolean;
		skipped?: boolean;
		failed?: boolean;
	}>;
	continueRepair(): Promise<void>;
	health: WorkerHealth;
}) {
	async function run(message: QueueMessage): Promise<void> {
		const repairMessage =
			message !== null &&
			"source" in message &&
			(message.source === "static" || message.source === "hobo-ci") &&
			"name" in message &&
			message.name === "hobo-ci-repair";
		const scheduled = repairMessage && message.source === "static";
		let failed = false;
		try {
			await options.tick();
			await options.health.mark("queue", true);
		} catch (error) {
			reportWorkerFailure("tick", error instanceof Error ? error : undefined);
			failed = true;
			await options.health.mark("queue", false);
		}
		if (repairMessage) {
			try {
				const result = await options.repair();
				if (result.truncated) throw new Error("delivery history incomplete");
				if (result.more) await options.continueRepair();
				if (result.failed) throw new Error("delivery repair failed");
				// Successful partial progress is neither a completed scan nor a
				// failure. Preserve the last completed scan's health until the
				// continuation finishes or that evidence expires.
				if (!result.skipped && !result.more)
					await options.health.mark("repair", true);
			} catch (error) {
				reportWorkerFailure(
					"repair",
					error instanceof Error ? error : undefined,
				);
				failed = true;
				await options.health.mark("repair", false);
			}
			if (scheduled) await options.health.mark("schedule", !failed);
		}
		if (failed) throw new Error("hosted worker failed");
	}
	return { run, ready: () => options.health.ready() };
}

/** Do not run concurrently: each scanner holds one connection and uses another. */
export async function runRepairs(
	repairs: readonly (() => Promise<{
		more: boolean;
		truncated: boolean;
		failed?: boolean;
		skipped?: boolean;
	}>)[],
	evidence?: {
		start(): Promise<string>;
		finish(index: number, ok: boolean, startedAt: string): Promise<void>;
	},
) {
	let failed = false,
		more = false,
		truncated = false;
	for (const [index, repair] of repairs.entries()) {
		let startedAt: string | undefined;
		try {
			startedAt = await evidence?.start();
			const result = await repair();
			if (result.failed)
				reportWorkerFailure("repair-scanner", undefined, index);
			failed ||= result.failed === true;
			more ||= result.more;
			truncated ||= result.truncated;
			if (evidence && startedAt) {
				if (result.failed || result.truncated)
					await evidence.finish(index, false, startedAt);
				else if (!result.more && !result.skipped)
					await evidence.finish(index, true, startedAt);
			}
		} catch (error) {
			reportWorkerFailure(
				"repair-scanner",
				error instanceof Error ? error : undefined,
				index,
			);
			failed = true;
			if (evidence && startedAt) await evidence.finish(index, false, startedAt);
		}
	}
	return { failed, more, truncated };
}

import { z } from "zod";

export const QueueMessageSchema = z.union([
	z
		.object({ deliveryId: z.string().min(1) })
		.passthrough()
		.refine((message) => !("source" in message) && !("name" in message)),
	z
		.object({
			source: z.enum(["static", "hobo-ci"]),
			name: z.literal("hobo-ci-repair"),
		})
		.passthrough()
		.refine((message) => !("deliveryId" in message)),
	z.null(),
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

/** A run published by a Vercel Schedule carries the schedule's identity; the
 * relay's own repair and continuation messages do not. */
export function isPlatformScheduleRun(message: QueueMessage): boolean {
	return message !== null && "scheduleId" in message;
}
