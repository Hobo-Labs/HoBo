/**
 * The box relay's fleet verdict reporter (ADR-0180; plan 0025, 6.2–6.3).
 *
 * Every 10 s, on its own unreferenced timer, it asks for an evaluation
 * (`fleet-verdict-evaluator.ts`), holds it (`fleet-verdict-state.ts`), and
 * when a report is due sends one signed `PUT /v1/fleet/verdicts/{owner}/{repo}`
 * per connected repository to the hosted relay, each with a 3 s limit. Nothing
 * in admission, dispatch or the poller awaits it: a sample still running when
 * the next is due is skipped, so a hanging relay holds up only the reporter.
 *
 * Modes: `off` (no reporter), `shadow` (evaluates, logs and reports with
 * `mode: "shadow"`, which the relay keeps but never serves) and `report`.
 * On drain it sends one last report that blocks nothing, best effort.
 */
import { z } from "zod";
import {
	FLEET_VERDICT_MODES,
	type FleetVerdictMode,
	fleetVerdictReportJson,
} from "../fleet-verdict.js";
import {
	FLEET_REPORTER_ID,
	type FleetVerdictSigner,
	signedFleetVerdictRequest,
} from "../fleet-verdict-auth.js";
import {
	type FleetExternalPool,
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

/** One request's limit. */
export const FLEET_VERDICT_SEND_TIMEOUT_MS = 3_000;
/** A steady state is logged again this often. */
export const FLEET_VERDICT_LOG_EVERY_MS = 5 * 60_000;
/** An unaccounted runner prefix is logged again this often. */
export const FLEET_VERDICT_UNACCOUNTED_LOG_EVERY_MS = 60 * 60_000;

export type FleetVerdictReporterEvent =
	| "hobo_ci_fleet_verdict_state"
	| "hobo_ci_fleet_verdict_unaccounted_runner";

export type FleetVerdictReporterLog = (
	event: FleetVerdictReporterEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

/** Hands out report sequences; see `createFleetVerdictSequence`. */
export type FleetVerdictSequenceSource = Readonly<{
	next(nowMs: number): bigint;
}>;

export type FleetVerdictReporterOptions = Readonly<{
	mode: FleetVerdictMode;
	reporterId: string;
	/** The hosted relay's public origin; reports are signed against it. */
	origin: string;
	identity: FleetVerdictSigner;
	/** The fleet labels this box serves. */
	labels: readonly string[];
	/** One evaluation of the box as it is now. */
	evaluate: () => FleetVerdictEvaluation | Promise<FleetVerdictEvaluation>;
	/** The connected repositories (`owner/name`), one report each. */
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

	/** One signed request, abandoned after the limit whatever `fetch` does. */
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

	/** One report per connected repository; true only when every one landed. */
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
			// No report: the relay's entry lapses on its own (F15).
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

	/** Takes one sample unless the last one is still running. */
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
		/** What the reporter holds blocked now. */
		blocked: () => holds.blocked(),
		start(): void {
			if (timer || stopped) return;
			timer = setInterval(() => void sample(), sampleMs);
			timer.unref?.();
			void sample();
		},
		/**
		 * Stops sampling and sends one report that blocks nothing, best
		 * effort: each request still has its limit, and a failure is logged.
		 */
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

const Pools = z
	.array(
		z
			.object({
				labels: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)).min(1),
				runnerNamePrefix: z.string().min(1).max(128),
				maxRunners: z.number().int().min(0).max(10_000),
			})
			.strict(),
	)
	.max(32);

/** The reporter's box settings (plan 0025, 6.3), parsed once at start. */
export type FleetVerdictReporterSettings =
	| Readonly<{ mode: "off" }>
	| Readonly<{
			mode: FleetVerdictMode;
			origin: string;
			reporterId: string;
			pools: readonly FleetExternalPool[];
			minFreeRunners: number;
			enterMs: number;
			exitMs: number;
	  }>;

function holdMs(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
): number {
	const value = env[name];
	if (value === undefined || value === "") return fallback;
	if (!/^\d{1,8}$/u.test(value)) throw new Error(`invalid ${name}`);
	const ms = Number(value);
	if (ms < FLEET_VERDICT_SAMPLE_MS || ms > 3_600_000)
		throw new Error(`invalid ${name}: between 10000 and 3600000 ms`);
	return ms;
}

function relayOrigin(value: string | undefined): string {
	let url: URL;
	try {
		url = new URL(value ?? "");
	} catch {
		throw new Error("invalid HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	)
		throw new Error(
			"invalid HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN: an https origin, nothing more",
		);
	return url.origin;
}

/**
 * Reads `HOBO_CI_FLEET_VERDICT_MODE` and the settings it needs. Any invalid
 * value throws, so the daemon refuses to start as it does for its other
 * settings. `meshNodeId` is the reporter id's default when there is a mesh.
 */
export function parseFleetVerdictReporterSettings(
	env: Readonly<Record<string, string | undefined>>,
	meshNodeId: string | undefined,
): FleetVerdictReporterSettings {
	const mode = env.HOBO_CI_FLEET_VERDICT_MODE ?? "off";
	if (mode === "off" || mode === "") return { mode: "off" };
	const known = FLEET_VERDICT_MODES.find((entry) => entry === mode);
	if (!known)
		throw new Error(
			"invalid HOBO_CI_FLEET_VERDICT_MODE: expected off, shadow or report",
		);
	const reporterId = env.HOBO_CI_FLEET_REPORTER_ID || meshNodeId;
	if (!reporterId)
		throw new Error(
			"missing HOBO_CI_FLEET_REPORTER_ID: required when there is no mesh",
		);
	if (!FLEET_REPORTER_ID.test(reporterId))
		throw new Error(
			"invalid HOBO_CI_FLEET_REPORTER_ID: expected ^[A-Za-z0-9_-]{1,64}$",
		);
	let pools: readonly FleetExternalPool[];
	try {
		pools = Pools.parse(
			JSON.parse(env.HOBO_CI_FLEET_EXTERNAL_POOLS_JSON || "[]"),
		);
	} catch {
		throw new Error("invalid HOBO_CI_FLEET_EXTERNAL_POOLS_JSON");
	}
	const minimum = env.HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS || "1";
	if (!/^[1-9]\d{0,3}$/u.test(minimum))
		throw new Error(
			"invalid HOBO_CI_FLEET_VERDICT_MIN_FREE_RUNNERS: an integer of at least 1",
		);
	return {
		mode: known,
		origin: relayOrigin(env.HOBO_CI_FLEET_VERDICT_RELAY_ORIGIN),
		reporterId,
		pools,
		minFreeRunners: Number(minimum),
		enterMs: holdMs(
			env,
			"HOBO_CI_FLEET_VERDICT_ENTER_MS",
			FLEET_VERDICT_ENTER_MS,
		),
		exitMs: holdMs(env, "HOBO_CI_FLEET_VERDICT_EXIT_MS", FLEET_VERDICT_EXIT_MS),
	};
}
