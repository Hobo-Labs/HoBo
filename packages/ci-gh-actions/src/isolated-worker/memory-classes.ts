import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

export type WorkerMemoryClassName = "light" | "standard" | "heavy";
export type WorkerMemoryClasses = Readonly<
	Record<WorkerMemoryClassName, number>
>;
export type WorkerMemoryConfig = Readonly<{
	budgetMb: number;
	reserveMb: number;
	classes: WorkerMemoryClasses;
	defaultClass: "standard";
	trunkReservationMb: number;
	holMs: number;
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
export type JobMemoryConfig = Readonly<{
	heapMb: number;
	turboConcurrency: number;
	vitestMaxWorkers: number;
}>;

export function computeJobMemoryConfig(input: {
	limitMb: number;
	cpuCount: number;
}): JobMemoryConfig {
	const heapBudgetMb = input.limitMb - 768;
	const vitestMaxWorkers = Math.max(
		1,
		Math.min(input.cpuCount, Math.floor(heapBudgetMb / 1280) - 1),
	);
	return {
		heapMb: Math.min(3072, Math.floor(heapBudgetMb / (vitestMaxWorkers + 1))),
		turboConcurrency: 1,
		vitestMaxWorkers,
	};
}

const JOB_CLASSES = {
	"CI fabric contract guard": "light",
	"Secret scan": "light",
	"Pricing release contract (static)": "light",
	"Attest GHCR images": "light",
	"Attest hobo-code GHCR image": "light",
	"CI runner image (mise oci)": "heavy",
	"PR impact gate": "heavy",
	"PR off-path checks (ts-autocode surface, production packages)": "heavy",
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

export function resolveWorkerMemoryConfig(
	env: Readonly<Record<string, string | undefined>>,
	host: HostMemory,
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
	const trunkReservationMb = host.trunkSlots > 0 ? classes.heavy : 0;
	const largestClassMb = Math.max(...Object.values(classes));
	if (
		budgetMb - trunkReservationMb < largestClassMb ||
		budgetMb < classes.heavy
	)
		throw new Error(
			`worker memory budget ${budgetMb} MiB cannot admit every class on an idle host: budget - trunk reservation = ${budgetMb - trunkReservationMb} MiB, largest class = ${largestClassMb} MiB, heavy trunk class = ${classes.heavy} MiB; adjust HOBO_CI_WORKER_MEMORY_BUDGET_MB, HOBO_CI_WORKER_MEMORY_RESERVE_MB, HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB, HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB, HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB, HOBO_CI_WORKER_MEMORY_MB, or HOBO_CI_WORKER_TRUNK_SLOTS`,
		);
	return {
		budgetMb,
		reserveMb,
		classes,
		defaultClass: "standard",
		trunkReservationMb,
		holMs: integer(
			env.HOBO_CI_WORKER_MEMORY_HOL_MS,
			60_000,
			"HOBO_CI_WORKER_MEMORY_HOL_MS",
			0,
		),
	};
}

export function memoryClassForJob(name: string): WorkerMemoryClassName {
	return JOB_CLASS_MAP.get(name) ?? "standard";
}

export function memoryRequestForJob(
	name: string,
	config: WorkerMemoryConfig,
): JobMemoryRequest {
	const memoryClass = memoryClassForJob(name);
	return { memoryClass, memoryMb: config.classes[memoryClass] };
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
	)
		return { memoryClass: job.memoryClass, memoryMb: job.memoryMb };
	return memoryRequestForJob(job.name, config);
}
