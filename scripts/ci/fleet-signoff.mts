/**
 * Choose how to verify a pull request from the same fleet evidence used by
 * runner routing. Local signoff is an opt-in fallback, never a runner label.
 */
import { execFileSync } from "node:child_process";
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
import {
	asObject,
	asText,
	parseJson,
	readRunnerRouting,
} from "./runner-routing.mts";

/** An enabled provider outside the fleet/local/hosted routing labels. */
export type FleetOverflowMember = Readonly<{
	id: string;
	runsOn: string;
	/** Is this a directly observable GitHub Actions runner label? */
	observable: boolean;
	/** Keep configured local and hosted providers in their normal order. */
	backend?: "arc" | "local" | "github";
}>;

export type FleetVerificationPlan =
	| Readonly<{
			kind: "runner";
			tier: "fleet" | "overflow" | "local" | "github";
			runner: string;
	  }>
	| Extract<FleetVerificationSelection, { kind: "local-signoff" | "wait" }>;

/** The base used for inventory must also be used for execution and signoff. */
export type FleetVerificationObservation =
	| Exclude<FleetVerificationPlan, { kind: "local-signoff" }>
	| Readonly<{ kind: "local-signoff"; baseSha: string }>;

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
	/** Extra enabled providers from the trusted base's declared inventory. */
	overflow?: readonly FleetOverflowMember[] | undefined;
	readSlip: () => Promise<SlipReading>;
	readQueue: (
		fleetLabel: string,
		busy: boolean,
		overflowLabels: readonly string[],
	) => Promise<QueueView>;
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
			tier === "fleet" ? [labels.fleet, labels.trunk] : [labels[tier]];
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
			tier: slip.decision.tier,
			runner: slip.decision.runner,
		};
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
			(input.overflow ?? [])
				.filter((entry) => entry.observable)
				.map((entry) => entry.runsOn.toLowerCase()),
		);
	} catch {
		return { kind: "wait", reason: "availability-unknown" };
	}
	const unknown: string[] = [];
	const member = (
		id: "fleet" | "local" | "github",
		enabled: boolean,
	): FleetMember => {
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
		const available =
			!rejectedBySlip && !reservedAhead && takingJobs(load, limits);
		const unavailable =
			rejectedBySlip ||
			refusingJobs(load, limits) ||
			(id === "github" && !available && input.githubUnavailable === true);
		if (enabled && !available && !unavailable) unknown.push(id);
		return {
			id,
			backend: id === "fleet" ? "hobo" : id,
			enabled,
			runsOn: runnerLabel,
			freeSlots: available ? 1 : 0,
		};
	};
	const overflow = (input.overflow ?? []).map((entry): FleetMember => {
		const id = `overflow:${entry.id}`;
		const load = labelLoad(queue.jobs, entry.runsOn.toLowerCase(), input.nowMs);
		const backend = entry.backend ?? "arc";
		const available =
			entry.observable &&
			(backend === "github" || queue.undecidedAhead === 0) &&
			takingJobs(load, settings.limits);
		const unavailable =
			entry.observable &&
			(refusingJobs(load, settings.limits) ||
				(backend === "github" &&
					!available &&
					input.githubUnavailable === true));
		if (!available && !unavailable) unknown.push(id);
		return {
			id,
			backend,
			enabled: true,
			runsOn: entry.runsOn,
			freeSlots: available ? 1 : 0,
		};
	});
	const selection = selectFleetVerification({
		members: [
			member("fleet", true),
			...overflow,
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
				: selection.runner.backend === "arc"
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
export function readFleetOverflowPolicy(
	text: string | undefined,
): readonly FleetOverflowMember[] | undefined {
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
	]);
	const extras: FleetOverflowMember[] = [];
	const add = (
		id: string,
		runsOn: string,
		observable: boolean,
		backend?: "local" | "github",
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
			if (Object.keys(provider).some((key) => !allowed.includes(key)))
				return undefined;
			const scaleSet = asObject(provider.scaleSet);
			const engine = asObject(provider.engine);
			if (
				(provider.scaleSet !== undefined && !scaleSet) ||
				(provider.engine !== undefined && !engine) ||
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
					kind === "local" || kind === "github" ? kind : undefined,
				);
		}
	}
	for (const [index, pool] of routing.externalPools.entries()) {
		if (pool.maxRunners === 0) continue;
		for (const runsOn of pool.labels)
			add(`external-pool:${index}:${runsOn}`, runsOn, true);
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
export async function observeFleetVerification(input: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	localSignoffEnabled: boolean;
	githubUnavailable?: boolean | undefined;
	/** The remote branch whose committed policy controls this decision. */
	baseRef?: string | undefined;
	/** Operator verified that live provider inventory matches the base. */
	policyCurrent?: boolean | undefined;
}): Promise<FleetVerificationObservation> {
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
	const overflow = readFleetOverflowPolicy(config);
	if (!overflow) return { kind: "wait", reason: "availability-unknown" };
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
	const readQueuePage = async (path: string): Promise<JsonValue> => {
		const body = await read(path);
		const field = path.includes("/jobs?") ? "jobs" : "workflow_runs";
		if (!Array.isArray(asObject(body)?.[field]))
			throw new Error(`malformed GitHub queue response: missing ${field}`);
		return body;
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
	const choice = await planFleetVerification({
		settings,
		localSignoffEnabled: input.localSignoffEnabled,
		githubUnavailable: input.githubUnavailable,
		overflow,
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
			}),
	});
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
