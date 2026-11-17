/**
 * Choose how to verify a pull request from the same fleet evidence used by
 * runner routing. Local signoff is an opt-in fallback, never a runner label.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FleetMember,
	type FleetVerificationSelection,
	selectFleetVerification,
} from "../../packages/ci/src/fleet-overflow.ts";
import {
	askSlip,
	type JsonValue,
	labelLoad,
	observeQueue,
	type QueueView,
	type RouteSettings,
	refusingJobs,
	routeSettings,
	type SlipReading,
	takingJobs,
} from "./route-runner.mts";
import { readRunnerRouting } from "./runner-routing.mts";

export type FleetVerificationPlan =
	| Readonly<{
			kind: "runner";
			tier: "fleet" | "local" | "github";
			runner: string;
	  }>
	| Extract<FleetVerificationSelection, { kind: "local-signoff" | "wait" }>;

/** Execute the selected fallback only; a failed local run cannot post a signoff. */
export async function executeFleetVerification(input: {
	choice: FleetVerificationPlan;
	runLocal: () => Promise<number>;
	signoffLocal: () => Promise<number>;
}): Promise<number> {
	if (input.choice.kind === "runner") return 0;
	if (input.choice.kind === "wait") return 1;
	const status = await input.runLocal();
	return status === 0 ? input.signoffLocal() : status;
}

/** Availability is unknown until a pickup or refusal is observed. */
export async function planFleetVerification(input: {
	settings: RouteSettings;
	localSignoffEnabled: boolean;
	/** Operator observation for hosted jobs that fail without ever queueing. */
	githubUnavailable?: boolean | undefined;
	readSlip: () => Promise<SlipReading>;
	readQueue: () => Promise<QueueView>;
	nowMs: number;
}): Promise<FleetVerificationPlan> {
	const { settings } = input;
	const { labels } = settings;
	if (settings.pin !== "auto")
		return {
			kind: "runner",
			tier: settings.pin,
			runner: labels[settings.pin],
		};
	const slip = await input.readSlip();
	if (
		slip.ok &&
		(slip.decision.tier !== "github" ||
			(slip.decision.slip?.kind === "used" &&
				slip.decision.slip.reason === "pinned"))
	)
		return {
			kind: "runner",
			tier: slip.decision.tier,
			runner: slip.decision.runner,
		};
	let queue: QueueView;
	try {
		queue = await input.readQueue();
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const unknown: string[] = [];
	const member = (
		id: "fleet" | "local" | "github",
		enabled: boolean,
	): FleetMember => {
		const load = labelLoad(queue.jobs, labels[id], input.nowMs);
		// A slip choosing GitHub already rejected both self-hosted tiers.
		const rejectedBySlip =
			slip.ok && slip.decision.tier === "github" && id !== "github";
		const reservedAhead = id !== "github" && queue.undecidedAhead > 0;
		const available =
			!rejectedBySlip && !reservedAhead && takingJobs(load, settings.limits);
		const unavailable =
			rejectedBySlip ||
			refusingJobs(load, settings.limits) ||
			(id === "github" && !available && input.githubUnavailable === true);
		if (enabled && !available && !unavailable) unknown.push(id);
		return {
			id,
			backend: id === "fleet" ? "hobo" : id,
			enabled,
			runsOn: labels[id],
			freeSlots: available ? 1 : 0,
		};
	};
	const selection = selectFleetVerification({
		members: [
			member("fleet", true),
			member("local", settings.localRunner),
			member("github", true),
		],
		unknownMembers: unknown,
		localSignoffEnabled: input.localSignoffEnabled,
	});
	if (selection.kind !== "runner") return selection;
	return {
		kind: "runner",
		tier:
			selection.runner.backend === "hobo"
				? "fleet"
				: selection.runner.backend === "local"
					? "local"
					: "github",
		runner: selection.runner.runsOn,
	};
}

/** Select from a local checkout; all GitHub reads use the existing gh login. */
export async function observeFleetVerification(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	localSignoffEnabled: boolean;
	githubUnavailable?: boolean | undefined;
}): Promise<FleetVerificationPlan> {
	let config: string | undefined;
	try {
		config = readFileSync(join(input.cwd, ".hobo/ci.json"), "utf8");
	} catch {
		config = undefined;
	}
	const settings = routeSettings(readRunnerRouting(config));
	const environment = { ...input.env };
	for (const name of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_NAMESPACE",
		"GIT_PREFIX",
		"GIT_QUARANTINE_PATH",
	])
		delete environment[name];
	const deadline = Date.now() + 20_000;
	const gh = (args: readonly string[]) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("fleet observation timed out");
		return execFileSync("gh", args, {
			cwd: input.cwd,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: Math.min(5000, remaining),
			maxBuffer: 8 * 1024 * 1024,
		}).trim();
	};
	if (settings.pin !== "auto")
		return planFleetVerification({
			settings,
			localSignoffEnabled: input.localSignoffEnabled,
			readSlip: async () => ({ ok: false, why: "pinned" }),
			readQueue: async () => ({
				jobs: [],
				undecidedAhead: 0,
				probeUnderway: false,
			}),
			nowMs: Date.now(),
		});
	let repository: string;
	try {
		repository = gh([
			"repo",
			"view",
			"--json",
			"nameWithOwner",
			"--jq",
			".nameWithOwner",
		]);
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(
				repository,
			)
		)
			throw new Error("invalid repository");
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const read = async (path: string): Promise<JsonValue> => {
		// SAFETY: a successful GitHub API response is parsed as JSON data.
		return JSON.parse(gh(["api", path])) as JsonValue;
	};
	const apiFetch: typeof fetch = async (request) => {
		const url = new URL(
			request instanceof Request ? request.url : request.toString(),
		);
		try {
			return new Response(
				JSON.stringify(await read(`${url.pathname}${url.search}`)),
				{ status: 200 },
			);
		} catch {
			return new Response(null, { status: 503 });
		}
	};
	const nowMs = Date.now();
	return planFleetVerification({
		settings,
		localSignoffEnabled: input.localSignoffEnabled,
		githubUnavailable: input.githubUnavailable,
		nowMs,
		readSlip: () =>
			askSlip({
				apiUrl: "https://api.github.com",
				repository,
				token: "",
				labels: settings.labels,
				routeClass: "pr",
				nowMs: () => nowMs,
				fetch: apiFetch,
			}),
		readQueue: () =>
			observeQueue({
				read,
				repository,
				// A local decision follows every recently started GitHub run.
				ownRunId: Number.MAX_SAFE_INTEGER,
				labels: [
					settings.labels.fleet,
					...(settings.localRunner ? [settings.labels.local] : []),
					settings.labels.github,
				],
				limits: settings.limits,
				nowMs,
			}),
	});
}
