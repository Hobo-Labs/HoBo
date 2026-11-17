import {
	type FleetVerdictMode,
	fleetVerdictReportJson,
} from "../fleet-verdict.js";
import {
	type FleetVerdictSigner,
	signedFleetVerdictRequest,
} from "../fleet-verdict-auth.js";
import {
	type FleetVerdictEvaluation,
	fleetRunnerNamePrefix,
} from "./fleet-verdict-evaluator.js";
import {
	createFleetVerdictHolds,
	createFleetVerdictSchedule,
	FLEET_VERDICT_ENTER_MS,
	FLEET_VERDICT_EXIT_MS,
	FLEET_VERDICT_RESEND_MS,
	FLEET_VERDICT_SAMPLE_MS,
	FLEET_VERDICT_TTL_SECONDS,
} from "./fleet-verdict-state.js";

export const FLEET_VERDICT_SEND_TIMEOUT_MS = 3_000;
export const FLEET_VERDICT_LOG_EVERY_MS = 5 * 60_000;
export const FLEET_VERDICT_UNACCOUNTED_LOG_EVERY_MS = 60 * 60_000;

export type FleetVerdictReporterEvent =
	| "hobo_ci_fleet_verdict_state"
	| "hobo_ci_fleet_verdict_unaccounted_runner";

export type FleetVerdictReporterLog = (
	event: FleetVerdictReporterEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type FleetVerdictSequenceSource = Readonly<{
	next(nowMs: number): bigint;
}>;

export type FleetVerdictReporterOptions = Readonly<{
	mode: FleetVerdictMode;
	reporterId: string;
	origin: string;
	identity: FleetVerdictSigner;
	labels: readonly string[];
	evaluate: () => FleetVerdictEvaluation | Promise<FleetVerdictEvaluation>;
	repositories: () => Promise<readonly string[]>;
	sequence: FleetVerdictSequenceSource;
	fetch?: typeof fetch | undefined;
	now?: (() => number) | undefined;
	log?: FleetVerdictReporterLog | undefined;
	sampleMs?: number | undefined;
	enterMs?: number | undefined;
	exitMs?: number | undefined;
	resendMs?: number | undefined;
	sendTimeoutMs?: number | undefined;
}>;

export function createFleetVerdictReporter(
	options: FleetVerdictReporterOptions,
) {
	const now = options.now ?? Date.now;
	const send = options.fetch ?? fetch;
	const log = options.log ?? (() => undefined);
	const sampleMs = options.sampleMs ?? FLEET_VERDICT_SAMPLE_MS;
	const sendTimeoutMs = options.sendTimeoutMs ?? FLEET_VERDICT_SEND_TIMEOUT_MS;
	const holds = createFleetVerdictHolds({
		labels: options.labels,
		enterMs: options.enterMs ?? FLEET_VERDICT_ENTER_MS,
		exitMs: options.exitMs ?? FLEET_VERDICT_EXIT_MS,
	});
	const schedule = createFleetVerdictSchedule({
		resendMs: options.resendMs ?? FLEET_VERDICT_RESEND_MS,
	});
	const unaccountedLoggedAt = new Map<string, number>();
	let lastLoggedAtMs: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;

	async function put(
		repository: string,
		body: string,
		nowMs: number,
	): Promise<boolean> {
		const sequence = options.sequence.next(nowMs);
		const signed = signedFleetVerdictRequest({
			identity: options.identity,
			reporterId: options.reporterId,
			origin: options.origin,
			repository,
			body,
			issuedAt: new Date(nowMs).toISOString(),
			sequence: sequence.toString(),
		});
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<false>((resolve) => {
			timeout = setTimeout(() => {
				controller.abort();
				resolve(false);
			}, sendTimeoutMs);
			timeout.unref?.();
		});
		try {
			return await Promise.race([
				send(signed.url, {
					method: "PUT",
					headers: signed.headers,
					body: signed.body,
					signal: controller.signal,
				}).then(
					(response) => response.ok,
					() => false,
				),
				expired,
			]);
		} finally {
			clearTimeout(timeout);
		}
	}

	async function report(blocked: ReadonlySet<string>): Promise<boolean> {
		const nowMs = now();
		const body = fleetVerdictReportJson(
			new Map([...blocked].map((label) => [label, "no-capacity"] as const)),
			FLEET_VERDICT_TTL_SECONDS,
			options.mode,
		);
		const repositories = await options.repositories();
		let sent = true;
		for (const repository of repositories)
			if (!(await put(repository, body, nowMs))) sent = false;
		return sent;
	}

	function logUnaccounted(runners: readonly string[], nowMs: number): void {
		for (const runner of runners) {
			const prefix = fleetRunnerNamePrefix(runner);
			const last = unaccountedLoggedAt.get(prefix);
			if (
				last !== undefined &&
				nowMs - last < FLEET_VERDICT_UNACCOUNTED_LOG_EVERY_MS
			)
				continue;
			unaccountedLoggedAt.set(prefix, nowMs);
			log("hobo_ci_fleet_verdict_unaccounted_runner", { prefix, runner });
		}
	}

	async function sampleOnce(): Promise<void> {
		const nowMs = now();
		let evaluation: FleetVerdictEvaluation;
		try {
			evaluation = await options.evaluate();
		} catch (error) {
			log("hobo_ci_fleet_verdict_state", {
				mode: options.mode,
				status: "evaluation-failed",
				message: error instanceof Error ? error.message : "unknown",
			});
			return;
		}
		const changed = holds.observe(nowMs, new Set(evaluation.blocked.keys()));
		logUnaccounted(evaluation.unaccounted, nowMs);
		const blocked = holds.blocked();
		let sent: boolean | undefined;
		if (schedule.due(nowMs, changed)) {
			try {
				sent = await report(blocked);
			} catch {
				sent = false;
			}
			schedule.attempted(nowMs, sent);
		}
		if (
			changed ||
			lastLoggedAtMs === undefined ||
			nowMs - lastLoggedAtMs >= FLEET_VERDICT_LOG_EVERY_MS
		) {
			lastLoggedAtMs = nowMs;
			log("hobo_ci_fleet_verdict_state", {
				mode: options.mode,
				changed,
				blocked: [...blocked].join(","),
				refused: evaluation.refused,
				reasons: [...evaluation.labels]
					.map(([label, entry]) => `${label}=${entry.reasons.join("+")}`)
					.join(";"),
				sent: sent === undefined ? "not-due" : sent ? "sent" : "failed",
			});
		}
	}

	function sample(): Promise<void> {
		if (stopped) return Promise.resolve();
		if (inFlight) return inFlight;
		const current = sampleOnce()
			.catch(() => undefined)
			.finally(() => {
				inFlight = undefined;
			});
		inFlight = current;
		return current;
	}

	return {
		sample,
		blocked: () => holds.blocked(),
		start(): void {
			if (timer || stopped) return;
			timer = setInterval(() => void sample(), sampleMs);
			timer.unref?.();
			void sample();
		},
		async clear(): Promise<void> {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			let sent = false;
			try {
				sent = await report(new Set());
			} catch {
				sent = false;
			}
			log("hobo_ci_fleet_verdict_state", {
				mode: options.mode,
				changed: true,
				blocked: "",
				status: "cleared",
				sent: sent ? "sent" : "failed",
			});
		},
	};
}

export type FleetVerdictReporter = ReturnType<
	typeof createFleetVerdictReporter
>;
