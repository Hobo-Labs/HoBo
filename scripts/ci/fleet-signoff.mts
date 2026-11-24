/**
 * Choose how to verify a pull request from the same fleet evidence used by
 * runner routing. Local signoff is an opt-in fallback, never a runner label.
 */
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import {
	type RunnerTierState,
	type RunnerVerificationSelection,
	selectRunnerVerification,
} from "../../packages/ci/src/runner-routing/tiers.ts";
import { trustedGithubTarget } from "./github-target.mts";
import {
	askSlip,
	type JsonValue,
	labelLoad,
	observeQueue,
	type QueueView,
	type RouteSettings,
	refusingJobs,
	routeSettings,
	type SeenJob,
	type SlipReading,
	takingJobs,
} from "./route-runner.mts";
import {
	asObject,
	asText,
	parseJson,
	readRunnerRouting,
} from "./runner-routing.mts";

/** Allow at most 30 seconds of GitHub/operator clock skew, never reversed ordering. */
export const SIGNOFF_CLOCK_SKEW_MS = 30_000;

type PreciseUtc = Readonly<{ secondMs: number; nanosecond: number }>;

/** GitHub UTC times allow up to nanoseconds; greater precision fails closed. */
function preciseUtc(value: JsonValue | undefined): PreciseUtc | undefined {
	const text = asText(value);
	const match =
		/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(
			text ?? "",
		);
	if (!match?.[1]) return undefined;
	const secondMs = Date.parse(`${match[1]}Z`);
	if (
		!Number.isFinite(secondMs) ||
		new Date(secondMs).toISOString().slice(0, 19) !== match[1]
	)
		return undefined;
	return { secondMs, nanosecond: Number((match[2] ?? "").padEnd(9, "0")) };
}

function compareUtc(first: PreciseUtc, second: PreciseUtc): number {
	return (
		first.secondMs - second.secondMs || first.nanosecond - second.nanosecond
	);
}

function withinClockSkew(value: JsonValue | undefined, nowMs: number): boolean {
	const timestamp = preciseUtc(value);
	if (!timestamp) return false;
	const boundMs = nowMs + SIGNOFF_CLOCK_SKEW_MS;
	const secondMs = Math.floor(boundMs / 1000) * 1000;
	return (
		compareUtc(timestamp, {
			secondMs,
			nanosecond: (boundMs - secondMs) * 1_000_000,
		}) <= 0
	);
}

function orderedUtc(
	first: JsonValue | undefined,
	second: JsonValue | undefined,
): boolean {
	const left = preciseUtc(first);
	const right = preciseUtc(second);
	return !!left && !!right && compareUtc(left, right) <= 0;
}

function validJobChronology(job: SeenJob, nowMs: number): boolean {
	return (
		Number.isFinite(job.createdAtMs) &&
		job.createdAtMs <= nowMs + SIGNOFF_CLOCK_SKEW_MS &&
		(job.startedAtMs === undefined ||
			(Number.isFinite(job.startedAtMs) &&
				job.startedAtMs >= job.createdAtMs &&
				job.startedAtMs <= nowMs + SIGNOFF_CLOCK_SKEW_MS))
	);
}

/** An enabled provider outside the fleet/local/hosted routing labels. */
export type RunnerOverflowMember = Readonly<{
	id: string;
	runsOn: string;
	/** Is this a directly observable GitHub Actions runner label? */
	observable: boolean;
	/** Keep configured local and hosted providers in their normal order. */
	backend?: "arc" | "local" | "github" | "agent37";
}>;

export type RunnerVerificationPlan =
	| Readonly<{
			kind: "runner";
			tier: "fleet" | "overflow" | "local" | "github";
			runner: string;
	  }>
	| Extract<RunnerVerificationSelection, { kind: "local-signoff" | "wait" }>;

/** The base used for inventory must also be used for execution and signoff. */
export type RunnerVerificationObservation =
	| Exclude<RunnerVerificationPlan, { kind: "local-signoff" }>
	| Readonly<{ kind: "invalid-provider-assertion"; provider: string }>
	| Readonly<{ kind: "invalid-runner-assertion"; runner: string }>
	| Readonly<{ kind: "local-signoff"; baseSha: string }>;

/** Execute the selected fallback only; a failed local run cannot post a signoff. */
export async function executeRunnerVerification(input: {
	choice: RunnerVerificationPlan;
	runLocal: () => Promise<number>;
	signoffLocal: () => Promise<number>;
}): Promise<number> {
	if (input.choice.kind === "runner") return 0;
	if (input.choice.kind === "wait") return 1;
	const status = await input.runLocal();
	return status === 0 ? input.signoffLocal() : status;
}

/** Availability is unknown until a pickup or refusal is observed. */
export async function planRunnerVerification(input: {
	settings: RouteSettings;
	localSignoffEnabled: boolean;
	/** Operator observation for hosted jobs that fail without ever queueing. */
	githubUnavailable?: boolean | undefined;
	/** Extra enabled providers from the trusted base's declared inventory. */
	overflow?: readonly RunnerOverflowMember[] | undefined;
	/** Independently observed outages of identified inventory members. */
	providerUnavailable?: readonly string[] | undefined;
	/** Independently observed outage of the fleet or enabled local tier. */
	runnerUnavailable?: readonly string[] | undefined;
	readSlip: () => Promise<SlipReading>;
	readQueue: (
		fleetLabel: string,
		busy: boolean,
		overflowLabels: readonly string[],
	) => Promise<QueueView>;
	nowMs: number;
}): Promise<RunnerVerificationPlan> {
	const { settings } = input;
	const { labels } = settings;
	if (settings.pin !== "auto")
		return {
			kind: "runner",
			tier: settings.pin,
			runner: labels[settings.pin],
		};
	let slip: SlipReading;
	try {
		slip = await input.readSlip();
	} catch {
		slip = { ok: false, why: "routing slip unavailable" };
	}
	// A globally allowed label can still contradict the slip's claimed tier.
	// Ignore such a slip rather than let it suppress a real runner.
	if (slip.ok) {
		const { tier, runner } = slip.decision;
		const allowed =
			tier === "fleet"
				? [labels.fleet, labels.trunk]
				: tier === "local" || tier === "github"
					? [labels[tier]]
					: tier === "agent37"
						? (input.overflow ?? [])
								.filter((entry) => entry.id.startsWith("external-pool:"))
								.map((entry) => entry.runsOn)
						: [];
		if (!allowed.some((label) => label.toLowerCase() === runner.toLowerCase()))
			slip = { ok: false, why: "routing slip tier and label disagree" };
	}
	if (
		slip.ok &&
		slip.decision.slip?.kind === "used" &&
		slip.decision.slip.reason === "pinned"
	)
		return {
			kind: "runner",
			tier: slip.decision.tier === "agent37" ? "overflow" : slip.decision.tier,
			runner: slip.decision.runner,
		};
	if (!Number.isFinite(input.nowMs))
		return { kind: "wait", reason: "availability-unknown" };
	const fleetLabel =
		slip.ok && slip.decision.tier === "fleet"
			? slip.decision.runner
			: labels.fleet;
	const busy =
		slip.ok &&
		slip.decision.tier === "fleet" &&
		slip.decision.slip?.kind === "used" &&
		slip.decision.slip.reason === "fleet-busy";
	let queue: QueueView;
	try {
		queue = await input.readQueue(
			fleetLabel,
			busy,
			(input.overflow ?? []).map((entry) => entry.runsOn.toLowerCase()),
		);
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const validJobs = queue.jobs.filter((job) =>
		validJobChronology(job, input.nowMs),
	);
	const incompleteQueue = validJobs.length !== queue.jobs.length;
	queue = { ...queue, jobs: validJobs };
	const unknown: string[] = [];
	const providerOutages = new Set(input.providerUnavailable ?? []);
	// Multi-label jobs are deliberately excluded from normal routing load.
	// A recent timely pickup still prevents an outage assertion here, but does
	// not establish that a job needing only this one label would be accepted.
	const multiLabelPickup = (label: string, limits: RouteSettings["limits"]) =>
		queue.jobs.some(
			(job) =>
				job.labels.length > 1 &&
				job.labels.some((candidate) => candidate.toLowerCase() === label) &&
				takingJobs(
					labelLoad([{ ...job, labels: [label] }], label, input.nowMs),
					limits,
				),
		);
	const member = (
		id: "fleet" | "local" | "github",
		enabled: boolean,
	): RunnerTierState => {
		const runnerLabel = id === "fleet" ? fleetLabel : labels[id];
		const load = labelLoad(queue.jobs, runnerLabel.toLowerCase(), input.nowMs);
		const limits =
			id === "fleet" && busy
				? { ...settings.limits, maxQueued: Number.MAX_SAFE_INTEGER }
				: settings.limits;
		// An unpinned fallback slip rejected the fleet only. Local enrollment
		// can change after the slip was issued, so it needs current evidence.
		const rejectedBySlip =
			slip.ok &&
			id === "fleet" &&
			(slip.decision.tier === "github" || slip.decision.tier === "local");
		const reservedAhead =
			id !== "github" && !(id === "fleet" && busy) && queue.undecidedAhead > 0;
		const healthy = takingJobs(load, limits);
		const available = !reservedAhead && healthy;
		// A fresh pickup is stronger evidence than an older slip or outage
		// assertion. A runner reserved by an earlier run remains unknown.
		const unavailable =
			!healthy &&
			!multiLabelPickup(runnerLabel.toLowerCase(), limits) &&
			(rejectedBySlip ||
				refusingJobs(load, limits) ||
				(id !== "github" && input.runnerUnavailable?.includes(id) === true) ||
				(id === "github" && input.githubUnavailable === true));
		if (enabled && !available && !unavailable) unknown.push(id);
		return {
			id,
			backend: id === "fleet" ? "hobo" : id,
			enabled,
			runsOn: runnerLabel,
			freeSlots: available ? 1 : 0,
		};
	};
	const overflow = (input.overflow ?? []).map((entry): RunnerTierState => {
		const id = `overflow:${entry.id}`;
		const load = labelLoad(queue.jobs, entry.runsOn.toLowerCase(), input.nowMs);
		const backend = entry.backend ?? "arc";
		const healthy = takingJobs(load, settings.limits);
		const available =
			entry.observable &&
			(backend === "github" || queue.undecidedAhead === 0) &&
			healthy;
		// An opaque backend cannot be inferred available from Actions, but a
		// healthy pickup on its label prevents declaring that member down.
		const unavailable =
			!healthy &&
			!multiLabelPickup(entry.runsOn.toLowerCase(), settings.limits) &&
			(providerOutages.has(entry.id) ||
				(entry.observable &&
					(refusingJobs(load, settings.limits) ||
						(backend === "github" && input.githubUnavailable === true) ||
						(backend === "local" &&
							input.runnerUnavailable?.includes("local") === true))));
		if (!available && !unavailable) unknown.push(id);
		return {
			id,
			backend,
			enabled: true,
			runsOn: entry.runsOn,
			freeSlots: available ? 1 : 0,
		};
	});
	const selection = selectRunnerVerification({
		members: [
			member("fleet", true),
			...overflow,
			member("local", settings.localRunner),
			member("github", true),
		],
		unknownMembers: unknown,
		localSignoffEnabled: input.localSignoffEnabled,
	});
	if (selection.kind !== "runner")
		return incompleteQueue
			? { kind: "wait", reason: "availability-unknown" }
			: selection;
	return {
		kind: "runner",
		tier:
			selection.runner.backend === "hobo"
				? "fleet"
				: selection.runner.backend === "arc" ||
						selection.runner.backend === "agent37"
					? "overflow"
					: selection.runner.backend === "local"
						? "local"
						: "github",
		runner: selection.runner.runsOn,
	};
}

/**
 * Read enabled provider labels from every environment in a trusted snapshot.
 * Unsupported inventory templates or references are unknown, not an empty
 * inventory. Non-inventory policy fields are not fully schema-validated here;
 * the operator must still compare this snapshot with the live account policy.
 */
export function readRunnerOverflowPolicy(
	text: string | undefined,
): readonly RunnerOverflowMember[] | undefined {
	const root = text === undefined ? undefined : asObject(parseJson(text));
	const routing = readRunnerRouting(text);
	const environments = asObject(root?.environments);
	const defaultEnvironment = asText(root?.defaultEnvironment);
	if (
		!root ||
		!routing ||
		!environments ||
		!defaultEnvironment ||
		!Object.hasOwn(environments, defaultEnvironment)
	)
		return undefined;
	const entries = Object.entries(environments);
	if (entries.length === 0 || entries.length > 32) return undefined;
	const name = /^[A-Za-z0-9_-]{1,80}$/u;
	const label = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
	const directKinds = new Set([
		"local",
		"github",
		"blacksmith",
		"depot",
		"warpbuild",
	]);
	const allKinds = new Set([
		...directKinds,
		"kubernetes",
		"hobo-box-worker",
		"vercel",
		"agent37",
	]);
	const extras: RunnerOverflowMember[] = [];
	const add = (
		id: string,
		runsOn: string,
		observable: boolean,
		backend?: "local" | "github" | "agent37",
	) => {
		if (backend === undefined) extras.push({ id, runsOn, observable });
		else extras.push({ id, runsOn, observable, backend });
	};
	for (const [environmentName, raw] of entries) {
		const environment = asObject(raw);
		const policy = asObject(environment?.policy);
		const account = asText(policy?.accountId);
		const tenant = asText(policy?.tenantId);
		const providers = policy?.providers;
		if (
			!name.test(environmentName) ||
			!environment ||
			environment.extends !== undefined ||
			!policy ||
			!asObject(policy.pool) ||
			!asObject(policy.routing) ||
			!asObject(policy.budget) ||
			(policy.budgetPolicy !== undefined && !asObject(policy.budgetPolicy)) ||
			(policy.thresholds !== undefined && !Array.isArray(policy.thresholds)) ||
			!account ||
			!name.test(account) ||
			!tenant ||
			!name.test(tenant) ||
			!Array.isArray(providers) ||
			providers.length === 0 ||
			providers.length > 100
		)
			return undefined;
		const ids = new Set<string>();
		for (const rawProvider of providers) {
			const provider = asObject(rawProvider);
			const id = asText(provider?.id);
			const kind = asText(provider?.kind);
			const runsOn = asText(provider?.runsOn);
			const connection = asText(provider?.connectionRef);
			if (
				!provider ||
				!id ||
				!name.test(id) ||
				ids.has(id) ||
				!kind ||
				!allKinds.has(kind) ||
				!runsOn ||
				!label.test(runsOn) ||
				runsOn.toLowerCase() === "hobo" ||
				!connection ||
				!/^[A-Za-z0-9_.:/-]{1,200}$/u.test(connection) ||
				(provider.enabled !== undefined &&
					provider.enabled !== true &&
					provider.enabled !== false)
			)
				return undefined;
			ids.add(id);
			const allowed = ["id", "kind", "runsOn", "connectionRef", "enabled"];
			if (kind === "kubernetes") allowed.push("scaleSet", "engine");
			if (kind === "vercel") allowed.push("location");
			if (kind === "agent37") allowed.push("pool");
			if (Object.keys(provider).some((key) => !allowed.includes(key)))
				return undefined;
			const scaleSet = asObject(provider.scaleSet);
			const engine = asObject(provider.engine);
			const pool = asObject(provider.pool);
			if (
				(provider.scaleSet !== undefined && !scaleSet) ||
				(provider.engine !== undefined && !engine) ||
				(provider.pool !== undefined && !pool) ||
				(scaleSet && engine) ||
				(kind === "local" && runsOn !== "hobo-local-host") ||
				(kind === "github" && runsOn.toLowerCase() === "ubuntu-latest") ||
				(kind === "vercel" &&
					!["vercel", "local", "remote"].includes(
						asText(provider.location) ?? "",
					))
			)
				return undefined;
			const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
			if (
				engine &&
				(Object.keys(engine).some((key) => key !== "name") ||
					!dnsLabel.test(asText(engine.name) ?? ""))
			)
				return undefined;
			if (scaleSet) {
				const max = scaleSet.maxRunners;
				const min = scaleSet.minRunners === undefined ? 0 : scaleSet.minRunners;
				if (
					Object.keys(scaleSet).some(
						(key) =>
							!["name", "namespace", "minRunners", "maxRunners"].includes(key),
					) ||
					!dnsLabel.test(asText(scaleSet.name) ?? "") ||
					!dnsLabel.test(asText(scaleSet.namespace) ?? "") ||
					!Number.isInteger(max) ||
					!Number.isInteger(min) ||
					Number(max) < 1 ||
					Number(max) > 1000 ||
					Number(min) < 0 ||
					Number(min) > Number(max)
				)
					return undefined;
			}
			// Protobuf's omitted bool is false.
			if (provider.enabled === true)
				add(
					`${environmentName}:${id}`,
					runsOn,
					directKinds.has(kind) || !!scaleSet,
					kind === "local" || kind === "github"
						? kind
						: kind === "agent37"
							? "agent37"
							: undefined,
				);
		}
	}
	for (const [index, pool] of routing.externalPools.entries()) {
		if (pool.maxRunners === 0) continue;
		for (const runsOn of pool.labels)
			add(`external-pool:${index}:${runsOn}`, runsOn, false);
	}
	if (root.integrations !== undefined) {
		if (!Array.isArray(root.integrations) || root.integrations.length > 16)
			return undefined;
		const ids = new Set<string>();
		for (const entry of root.integrations) {
			const integration = asObject(entry);
			const id = asText(integration?.id);
			const provider = asText(integration?.provider);
			if (
				!integration ||
				!id ||
				!name.test(id) ||
				ids.has(id) ||
				!provider ||
				!["blacksmith", "depot", "jog", "boat"].includes(provider) ||
				!Array.isArray(integration.runsOn) ||
				integration.runsOn.length === 0 ||
				integration.runsOn.length > 8 ||
				(integration.enabled !== undefined &&
					integration.enabled !== true &&
					integration.enabled !== false)
			)
				return undefined;
			ids.add(id);
			for (const rawLabel of integration.runsOn) {
				const runsOn = asText(rawLabel);
				if (!runsOn || !label.test(runsOn)) return undefined;
				// The connect command omits this optional flag; omission is not off.
				if (integration.enabled !== false)
					add(`integration:${id}:${runsOn}`, runsOn, true);
			}
		}
	}
	return extras;
}

/** Select from a local checkout; all GitHub reads use the existing gh login. */
export async function observeRunnerVerification(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	localSignoffEnabled: boolean;
	githubUnavailable?: boolean | undefined;
	/** The remote branch whose committed policy controls this decision. */
	baseRef?: string | undefined;
	/** Operator verified that live provider inventory matches the base. */
	policyCurrent?: boolean | undefined;
	/** Operator observed that each named inventory member is unavailable. */
	providerUnavailable?: readonly string[] | undefined;
	/** Operator observed that each named runner tier is unavailable. */
	runnerUnavailable?: readonly string[] | undefined;
}): Promise<RunnerVerificationObservation> {
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
	delete environment.GIT_REPLACE_REF_BASE;
	environment.GIT_NO_REPLACE_OBJECTS = "1";
	environment.GIT_GRAFT_FILE = devNull;
	const git = (args: readonly string[]) =>
		execFileSync("git", args, {
			cwd: input.cwd,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		}).trim();
	const baseRef = input.baseRef ?? "origin/main";
	const remoteBranch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/u.exec(baseRef);
	if (!remoteBranch?.[1] || !remoteBranch[2])
		return { kind: "wait", reason: "availability-unknown" };
	const [, remote, branch] = remoteBranch;
	const branchRef = `refs/heads/${branch}`;
	let config: string;
	let base: string;
	try {
		git(["check-ref-format", branchRef]);
		base = git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base)) throw new Error();
		config = git(["show", `${base}:.hobo/ci.json`]);
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const routing = readRunnerRouting(config);
	if (!routing) return { kind: "wait", reason: "availability-unknown" };
	const settings = routeSettings(routing);
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
		return {
			kind: "runner",
			tier: settings.pin,
			runner: settings.labels[settings.pin],
		};
	let repository: string;
	try {
		const target = trustedGithubTarget({
			cwd: input.cwd,
			remoteUrl: git(["remote", "get-url", remote]),
			env: environment,
		});
		repository = target.repository;
		Object.assign(environment, target.environment);
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const inventory = readRunnerOverflowPolicy(config);
	// Missing inventory must not prevent a pinned slip or an observed runner,
	// but it is an unknown tier and can never establish fallback eligibility.
	const overflow = inventory ?? [
		{
			id: "@unknown-inventory",
			runsOn: "unknown-inventory",
			observable: false,
		},
	];
	const assertions = input.providerUnavailable ?? [];
	const runnerAssertions = input.runnerUnavailable ?? [];
	const counts = new Map<string, number>();
	for (const entry of inventory ?? [])
		counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
	const seenAssertions = new Set<string>();
	const invalidProvider = inventory
		? assertions.find((id) => {
				const invalid = seenAssertions.has(id) || counts.get(id) !== 1;
				seenAssertions.add(id);
				return invalid;
			})
		: undefined;
	const localEnabled =
		settings.localRunner ||
		inventory?.some((entry) => entry.backend === "local") === true;
	const invalidRunner = runnerAssertions.find(
		(id, index) =>
			runnerAssertions.indexOf(id) !== index ||
			(id !== "fleet" && id !== "local") ||
			(id === "local" && inventory !== undefined && !localEnabled),
	);
	const read = async (path: string): Promise<JsonValue> => {
		// SAFETY: a successful GitHub API response is parsed as JSON data.
		return JSON.parse(gh(["api", path])) as JsonValue;
	};
	const nowMs = Date.now();
	let incompleteQueue = false;
	let uncertainInProgress = false;
	const readQueuePage = async (path: string): Promise<JsonValue> => {
		const body = await read(path);
		const field = path.includes("/jobs?") ? "jobs" : "workflow_runs";
		const items = asObject(body)?.[field];
		const validTime = (value: JsonValue | undefined) =>
			withinClockSkew(value, nowMs);
		const validId = (value: JsonValue | undefined) =>
			Number.isSafeInteger(value) && Number(value) > 0;
		const statuses = [
			"queued",
			"in_progress",
			"completed",
			"pending",
			"waiting",
			"requested",
		];
		if (!Array.isArray(items))
			throw new Error(`malformed GitHub queue response: missing ${field}`);
		const validItems = items.filter((entry) => {
			const item = asObject(entry);
			const status = asText(item?.status);
			if (!item || !status || !statuses.includes(status)) return false;
			if (field === "workflow_runs")
				return (
					validId(item.id) &&
					(asText(item.path)?.trim().length ?? 0) > 0 &&
					validTime(item.created_at) &&
					validTime(item.updated_at) &&
					orderedUtc(item.created_at, item.updated_at)
				);
			const runner = asText(item.runner_name);
			return (
				validId(item.run_id) &&
				validTime(item.created_at) &&
				Array.isArray(item.labels) &&
				item.labels.every((label) => (asText(label)?.length ?? 0) > 0) &&
				(item.labels.length > 0 || (status === "completed" && !runner)) &&
				(item.runner_name === null || runner !== undefined) &&
				(status !== "queued" || !runner) &&
				(status !== "completed" ||
					!!runner ||
					["skipped", "cancelled"].includes(asText(item.conclusion) ?? "")) &&
				(item.started_at === null || validTime(item.started_at)) &&
				(!runner || validTime(item.started_at)) &&
				(item.started_at === null ||
					orderedUtc(item.created_at, item.started_at))
			);
		});
		if (validItems.length !== items.length) incompleteQueue = true;
		if (
			field === "jobs" &&
			validItems.some((entry) => {
				const item = asObject(entry);
				return (
					asText(item?.status) === "in_progress" && !asText(item?.runner_name)
				);
			})
		)
			uncertainInProgress = true;
		return { [field]: validItems };
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
	const choice = await planRunnerVerification({
		settings,
		localSignoffEnabled: input.localSignoffEnabled,
		githubUnavailable: input.githubUnavailable,
		overflow,
		providerUnavailable: inventory ? assertions : [],
		runnerUnavailable: runnerAssertions,
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
		readQueue: (fleetLabel, busy, overflowLabels) =>
			observeQueue({
				read: readQueuePage,
				repository,
				// A local decision follows every recently started GitHub run.
				ownRunId: Number.MAX_SAFE_INTEGER,
				labels: [
					fleetLabel,
					...(settings.localRunner ? [settings.labels.local] : []),
					settings.labels.github,
					...overflowLabels,
				],
				limits: busy
					? { ...settings.limits, maxQueued: Number.MAX_SAFE_INTEGER }
					: settings.limits,
				nowMs,
				exhaustLookups: true,
			}),
	});
	if (choice.kind === "runner") return choice;
	if (invalidProvider !== undefined)
		return { kind: "invalid-provider-assertion", provider: invalidProvider };
	if (invalidRunner !== undefined)
		return { kind: "invalid-runner-assertion", runner: invalidRunner };
	if (incompleteQueue || uncertainInProgress)
		return { kind: "wait", reason: "availability-unknown" };
	if (choice.kind !== "local-signoff") return choice;
	if (input.policyCurrent !== true)
		return { kind: "wait", reason: "availability-unknown" };
	try {
		const advertised = git([
			"ls-remote",
			"--exit-code",
			"--heads",
			remote,
			branchRef,
		]);
		if (advertised !== `${base}\t${branchRef}`) throw new Error();
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	return { ...choice, baseSha: base };
}
