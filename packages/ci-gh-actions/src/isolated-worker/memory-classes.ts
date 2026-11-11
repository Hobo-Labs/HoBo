import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import {
	learnedReservationMb,
	type MemoryPeakHistories,
} from "./memory-peaks.js";

export {
	computeJobMemoryConfig,
	type JobMemoryConfig,
} from "./job-memory-config.js";

export type WorkerMemoryClassName = "light" | "standard" | "heavy";
export type WorkerMemoryClasses = Readonly<
	Record<WorkerMemoryClassName, number>
>;
export type WorkerMemoryConfig = Readonly<{
	budgetMb: number;
	reserveMb: number;
	classes: WorkerMemoryClasses;
	unmeasured: WorkerMemoryClasses;
	defaultClass: "standard";
	trunkReservationMb: number;
	holMs: number;
	learn: boolean;
	memoryPeaks?: MemoryPeakHistories;
}>;
export type HostMemorySample = Readonly<{
	totalMemoryMb: number;
	cgroupMemoryLimitMb?: number;
}>;
export type HostMemory = Readonly<HostMemorySample & { trunkSlots: number }>;
export type JobMemoryRequest = Readonly<{
	memoryClass: WorkerMemoryClassName;
	memoryMb: number;
}>;

const JOB_CLASSES = {
	"CI fabric contract guard": "light",
	"Secret scan": "light",
	"Pricing release contract (static)": "light",
	"Attest GHCR images": "light",
	"Attest hobo-code GHCR image": "light",
	"CI runner image (mise oci)": "heavy",
	"PR impact gate": "light",
	"PR impact validation": "heavy",
	"PR affected package lanes": "heavy",
	"PR off-path checks (ts-autocode surface, production packages)": "heavy",
	// Installs, builds some two dozen packages and runs five suites; its two
	// database servers sit beside the job, outside what admission counts.
	"Live data engines (PostgreSQL 16, MongoDB 8)": "heavy",
	"Main full gate": "heavy",
	"HoBo Code contract, lint, test + OCI image": "heavy",
	"Release contract + affected OCI images": "heavy",
	"Publish npm + GHCR (tagged release)": "heavy",
	"Stage npm package + publish hobo-code GHCR image": "heavy",
	"Build and test @hobo/pricing (release cone)": "heavy",
	"@hobo/pricing affected gate": "heavy",
	"Clean container bootstrap": "heavy",
	"dagger-native": "heavy",
} satisfies Readonly<Record<string, WorkerMemoryClassName>>;
const JOB_CLASS_MAP = new Map(Object.entries(JOB_CLASSES));

function integer(
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number,
): number {
	const parsed = Number(value ?? String(fallback));
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > 1_048_576)
		throw new Error(`invalid ${name}`);
	return parsed;
}

function unmeasuredReservation(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
	classMb: number,
): number {
	const reservationMb = integer(env[name], fallback, name, 512);
	if (reservationMb > classMb) throw new Error(`invalid ${name}`);
	return reservationMb;
}

export function readHostMemory(): HostMemorySample {
	const totalMemoryMb = Math.floor(totalmem() / 1024 / 1024);
	let cgroup: string | undefined;
	try {
		cgroup = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
	} catch {
		return { totalMemoryMb };
	}
	if (cgroup === "max") return { totalMemoryMb };
	const bytes = Number(cgroup);
	if (!Number.isSafeInteger(bytes) || bytes < 1)
		throw new Error("invalid /sys/fs/cgroup/memory.max");
	return {
		totalMemoryMb,
		cgroupMemoryLimitMb: Math.floor(bytes / 1024 / 1024),
	};
}

export function parseAvailableMemoryMb(input: string): number | undefined {
	const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/mu.exec(input);
	if (!match?.[1]) return undefined;
	const availableKb = Number(match[1]);
	if (!Number.isSafeInteger(availableKb)) return undefined;
	return Math.floor(availableKb / 1024);
}

export function readAvailableMemoryMb(
	path = "/proc/meminfo",
): number | undefined {
	try {
		return parseAvailableMemoryMb(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function resolveWorkerMemoryConfig(
	env: Readonly<Record<string, string | undefined>>,
	host: HostMemory,
	memoryPeaks?: MemoryPeakHistories,
): WorkerMemoryConfig {
	if (!Number.isInteger(host.totalMemoryMb) || host.totalMemoryMb < 1)
		throw new Error("invalid host total memory");
	if (
		host.cgroupMemoryLimitMb !== undefined &&
		(!Number.isInteger(host.cgroupMemoryLimitMb) ||
			host.cgroupMemoryLimitMb < 1)
	)
		throw new Error("invalid cgroup memory limit");
	if (!Number.isInteger(host.trunkSlots) || host.trunkSlots < 0)
		throw new Error("invalid worker trunk slots");
	const reserveMb = integer(
		env.HOBO_CI_WORKER_MEMORY_RESERVE_MB,
		2_048,
		"HOBO_CI_WORKER_MEMORY_RESERVE_MB",
		2_048,
	);
	const availableMb =
		Math.min(
			host.totalMemoryMb,
			host.cgroupMemoryLimitMb ?? Number.MAX_SAFE_INTEGER,
		) - reserveMb;
	const budgetMb =
		env.HOBO_CI_WORKER_MEMORY_BUDGET_MB === undefined
			? availableMb
			: integer(
					env.HOBO_CI_WORKER_MEMORY_BUDGET_MB,
					0,
					"HOBO_CI_WORKER_MEMORY_BUDGET_MB",
					1,
				);
	if (budgetMb > availableMb)
		throw new Error(
			`worker memory budget ${budgetMb} MiB exceeds host/cgroup memory minus reserve ${availableMb} MiB`,
		);
	const classes = {
		light: integer(
			env.HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB,
			3_072,
			"HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB",
			3_072,
		),
		standard: integer(
			env.HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB,
			4_096,
			"HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB",
			3_072,
		),
		heavy: integer(
			env.HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB ?? env.HOBO_CI_WORKER_MEMORY_MB,
			6_144,
			"HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB",
			3_072,
		),
	} satisfies WorkerMemoryClasses;
	const unmeasured = {
		light: unmeasuredReservation(
			env,
			"HOBO_CI_WORKER_MEMORY_LIGHT_RESERVE_MB",
			1_024,
			classes.light,
		),
		standard: unmeasuredReservation(
			env,
			"HOBO_CI_WORKER_MEMORY_STANDARD_RESERVE_MB",
			2_048,
			classes.standard,
		),
		heavy: unmeasuredReservation(
			env,
			"HOBO_CI_WORKER_MEMORY_HEAVY_RESERVE_MB",
			4_096,
			classes.heavy,
		),
	} satisfies WorkerMemoryClasses;
	const learnSetting = env.HOBO_CI_WORKER_MEMORY_LEARN ?? "1";
	if (learnSetting !== "0" && learnSetting !== "1")
		throw new Error("invalid HOBO_CI_WORKER_MEMORY_LEARN");
	const learn = learnSetting === "1";
	const trunkReservationMb =
		host.trunkSlots > 0
			? learn
				? learnedReservationMb(
						memoryPeaks?.["Main full gate"],
						classes.heavy,
						unmeasured.heavy,
					)
				: classes.heavy
			: 0;
	const largestClassMb = Math.max(...Object.values(classes));
	if (
		budgetMb - trunkReservationMb < largestClassMb ||
		budgetMb < classes.heavy
	)
		throw new Error(
			`worker memory budget ${budgetMb} MiB cannot admit every class on an idle host: budget - trunk reservation = ${budgetMb - trunkReservationMb} MiB, largest class = ${largestClassMb} MiB, heavy trunk class = ${classes.heavy} MiB; adjust HOBO_CI_WORKER_MEMORY_BUDGET_MB, HOBO_CI_WORKER_MEMORY_RESERVE_MB, HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB, HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB, HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB, HOBO_CI_WORKER_MEMORY_MB, or HOBO_CI_WORKER_TRUNK_SLOTS`,
		);
	const config: Omit<WorkerMemoryConfig, "memoryPeaks"> & {
		memoryPeaks?: MemoryPeakHistories;
	} = {
		budgetMb,
		reserveMb,
		classes,
		unmeasured,
		defaultClass: "standard",
		trunkReservationMb,
		holMs: integer(
			env.HOBO_CI_WORKER_MEMORY_HOL_MS,
			60_000,
			"HOBO_CI_WORKER_MEMORY_HOL_MS",
			0,
		),
		learn,
	};
	if (memoryPeaks) config.memoryPeaks = memoryPeaks;
	return config;
}

export const CI_DEPS_LAYER_JOB_NAME = "CI deps layer (pnpm)";
/** Class floor; learned peaks may raise the container limit above this. */
export const CI_DEPS_LAYER_MEMORY_FLOOR_MB = 4096;
/** Minimum reservation before three samples exist (4097 MiB peak observed on main). */
export const CI_DEPS_LAYER_MEMORY_LEARNED_MIN_MB = 4352;

function ciDepsLayerMemoryRequest(
	config: WorkerMemoryConfig,
): JobMemoryRequest {
	const floorMb = CI_DEPS_LAYER_MEMORY_FLOOR_MB;
	const ceilingMb = config.classes.heavy;
	const learnedMinMb = CI_DEPS_LAYER_MEMORY_LEARNED_MIN_MB;
	const history = config.memoryPeaks?.[CI_DEPS_LAYER_JOB_NAME];
	const memoryMb = Math.min(
		ceilingMb,
		Math.max(
			floorMb,
			config.learn
				? learnedReservationMb(history, ceilingMb, learnedMinMb)
				: ceilingMb,
		),
	);
	return { memoryClass: "heavy", memoryMb };
}

export function memoryClassForJob(name: string): WorkerMemoryClassName {
	if (/^Main workspace test shard \d+$/u.test(name)) return "standard";
	if (/^Workspace test shard [0-7](?: \([0-7]\))?$/u.test(name)) return "heavy";
	return JOB_CLASS_MAP.get(name) ?? "standard";
}

function mainWorkspaceShardMemoryRequest(
	name: string,
	config: WorkerMemoryConfig,
): JobMemoryRequest {
	const floorMb = config.classes.standard;
	const ceilingMb = config.classes.heavy;
	const reserved = config.learn
		? learnedReservationMb(config.memoryPeaks?.[name], ceilingMb, floorMb)
		: floorMb;
	const memoryMb = Math.max(floorMb, reserved);
	const memoryClass: WorkerMemoryClassName =
		memoryMb > floorMb ? "heavy" : "standard";
	return { memoryClass, memoryMb };
}

export function memoryRequestForJob(
	name: string,
	config: WorkerMemoryConfig,
): JobMemoryRequest {
	if (name === CI_DEPS_LAYER_JOB_NAME) return ciDepsLayerMemoryRequest(config);
	if (/^Main workspace test shard \d+$/u.test(name))
		return mainWorkspaceShardMemoryRequest(name, config);
	const memoryClass = memoryClassForJob(name);
	const classMb = config.classes[memoryClass];
	return {
		memoryClass,
		memoryMb: config.learn
			? learnedReservationMb(
					config.memoryPeaks?.[name],
					classMb,
					config.unmeasured[memoryClass],
				)
			: classMb,
	};
}

export function memoryRequestForStoredJob(
	job: Readonly<{ name: string; memoryClass: string; memoryMb: number }>,
	config: WorkerMemoryConfig,
): JobMemoryRequest {
	if (
		(job.memoryClass === "light" ||
			job.memoryClass === "standard" ||
			job.memoryClass === "heavy") &&
		Number.isInteger(job.memoryMb) &&
		job.memoryMb >= 512
	) {
		const classMb = config.classes[job.memoryClass];
		return {
			memoryClass: job.memoryClass,
			memoryMb: config.learn
				? learnedReservationMb(
						config.memoryPeaks?.[job.name],
						classMb,
						config.unmeasured[job.memoryClass],
					)
				: classMb,
		};
	}
	return memoryRequestForJob(job.name, config);
}
