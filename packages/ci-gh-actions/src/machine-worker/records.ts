import { create, fromJson, toJsonString } from "@bufbuild/protobuf";
import type { MachineEvent } from "@hobo/ci";
import { z } from "zod";
import {
	type StoredMachine,
	StoredMachineSchema,
	type WorkerEvent,
	WorkerEventSchema,
} from "../_generated/machine_worker_pb.js";

export type { StoredMachine, WorkerEvent };
export { StoredMachineSchema, WorkerEventSchema };

declare const parsedMachineWorkerRecord: unique symbol;
export type ParsedMachineWorkerRecord<T> = T & {
	readonly [parsedMachineWorkerRecord]: true;
};

export class MachineWorkerRecordRejection extends Error {
	override readonly name = "MachineWorkerRecordRejection";
}

function need(ok: boolean, problem: string): void {
	if (!ok) throw new MachineWorkerRecordRejection(problem);
}

function seal<T>(value: T): asserts value is ParsedMachineWorkerRecord<T> {
	Object.freeze(value);
}

function branded<T>(value: T): ParsedMachineWorkerRecord<T> {
	seal(value);
	return value;
}

const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const RUNNER = /^hobo-machine-[a-z0-9-]+-[0-9]+$/u;

export function defineStoredMachine(
	machine: StoredMachine,
): ParsedMachineWorkerRecord<StoredMachine> {
	need(MACHINE_ID.test(machine.id), "id is 1 to 63 of [a-z0-9-]");
	need(
		machine.name.length >= 1 && machine.name.length <= 100,
		"name is 1 to 100 characters",
	);
	return branded(Object.freeze(machine));
}

const StoredMachineWire = z
	.object({ id: z.string(), name: z.string() })
	.strict();

export function parseStoredMachine(
	text: string,
): ParsedMachineWorkerRecord<StoredMachine> {
	let wire: z.infer<typeof StoredMachineWire>;
	try {
		wire = StoredMachineWire.parse(JSON.parse(text));
	} catch {
		throw new MachineWorkerRecordRejection(
			"a stored machine is a JSON object with only an id and a name",
		);
	}
	return defineStoredMachine(fromJson(StoredMachineSchema, wire));
}

export function storedMachineJson(
	machine: ParsedMachineWorkerRecord<StoredMachine>,
): string {
	return `${toJsonString(StoredMachineSchema, machine)}\n`;
}

export const WORKER_EVENT_TYPES = [
	"worker.advertised",
	"worker.refused",
	"worker.job_started",
	"worker.job_finished",
	"worker.job_failed",
	"worker.job_refused",
	"worker.draining",
	"worker.handing_off",
] as const;
export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

const REFUSAL_REASONS = new Set([
	"malformed",
	"invalid_signature",
	"wrong_account",
	"wrong_owner",
	"stale",
	"taken_over",
]);

type WorkerField =
	| "detail"
	| "busy"
	| "slots"
	| "paused"
	| "reason"
	| "jobId"
	| "repository"
	| "runner"
	| "running";

const WORKER_FIELDS: readonly WorkerField[] = [
	"detail",
	"busy",
	"slots",
	"paused",
	"reason",
	"jobId",
	"repository",
	"runner",
	"running",
];

const JOB_FIELDS: readonly WorkerField[] = ["detail", "jobId", "repository"];
const REQUIRED = new Map<WorkerEventType, readonly WorkerField[]>([
	["worker.advertised", ["busy", "slots", "paused"]],
	["worker.refused", ["reason", "detail"]],
	["worker.job_started", JOB_FIELDS],
	["worker.job_finished", JOB_FIELDS],
	["worker.job_failed", JOB_FIELDS],
	["worker.job_refused", JOB_FIELDS],
	["worker.draining", ["running", "detail"]],
	["worker.handing_off", ["running", "detail"]],
]);
const MAY_NAME_RUNNER = new Set<WorkerEventType>([
	"worker.job_started",
	"worker.job_finished",
	"worker.job_failed",
]);

function workerType(value: string): WorkerEventType | undefined {
	return WORKER_EVENT_TYPES.find((type) => type === value);
}

export function defineWorkerEvent(
	event: WorkerEvent,
): ParsedMachineWorkerRecord<WorkerEvent> {
	const type = workerType(event.type);
	if (type === undefined)
		throw new MachineWorkerRecordRejection(
			`type is one of ${WORKER_EVENT_TYPES.join(", ")}`,
		);
	need(MACHINE_ID.test(event.machineId), "machineId is a machine id");
	need(Number.isFinite(event.atMs) && event.atMs >= 0, "atMs is epoch ms");
	const required = REQUIRED.get(type) ?? [];
	for (const field of WORKER_FIELDS) {
		const present = event[field] !== undefined;
		const allowed =
			required.includes(field) ||
			(field === "runner" && MAY_NAME_RUNNER.has(type));
		need(
			present === required.includes(field) || (present && allowed),
			`${type} ${required.includes(field) ? "needs" : "never has"} ${field}`,
		);
	}
	need(event.detail !== "", "detail is not empty");
	need(event.busy === undefined || event.busy <= 1000, "busy is at most 1000");
	need(
		event.slots === undefined || (event.slots >= 1 && event.slots <= 1000),
		"slots is 1 to 1000",
	);
	need(
		event.running === undefined || event.running <= 1000,
		"running is at most 1000",
	);
	need(
		event.reason === undefined || REFUSAL_REASONS.has(event.reason),
		"reason is a registry refusal reason",
	);
	need(
		event.jobId === undefined ||
			(Number.isSafeInteger(event.jobId) && event.jobId > 0),
		"jobId is a GitHub job id",
	);
	need(
		event.repository === undefined || REPOSITORY.test(event.repository),
		"repository is owner/name",
	);
	need(
		event.runner === undefined || RUNNER.test(event.runner),
		"runner is a one-job runner's name",
	);
	return branded(Object.freeze(event));
}

export type WorkerEventFields = Omit<WorkerEvent, "$typeName" | "$unknown">;

export function workerEvent(
	init: WorkerEventFields,
): ParsedMachineWorkerRecord<WorkerEvent> {
	return defineWorkerEvent(create(WorkerEventSchema, init));
}

const Json = z.json();

const WorkerEventWire = z
	.object({
		type: z.string(),
		machineId: z.string(),
		atMs: z.number(),
		detail: z.string().optional(),
		busy: z.number().optional(),
		slots: z.number().optional(),
		paused: z.boolean().optional(),
		reason: z.string().optional(),
		jobId: z.number().optional(),
		repository: z.string().optional(),
		runner: z.string().optional(),
		running: z.number().optional(),
	})
	.strict();

export function parseWorkerEvent(
	text: string,
): ParsedMachineWorkerRecord<WorkerEvent> {
	let wire: z.infer<typeof Json>;
	try {
		wire = Json.parse(JSON.parse(text));
		WorkerEventWire.parse(wire);
	} catch {
		throw new MachineWorkerRecordRejection(
			"a worker event is a JSON object with only its type's fields",
		);
	}
	let message: WorkerEvent;
	try {
		message = fromJson(WorkerEventSchema, wire);
	} catch {
		throw new MachineWorkerRecordRejection(
			"a worker event's fields have their protobuf types",
		);
	}
	return defineWorkerEvent(message);
}

export function workerEventJson(
	event: ParsedMachineWorkerRecord<WorkerEvent>,
): string {
	return toJsonString(WorkerEventSchema, event);
}

export type MachineWorkerEvent =
	| MachineEvent
	| ParsedMachineWorkerRecord<WorkerEvent>;

export function machineWorkerEventJson(event: MachineWorkerEvent): string {
	return "$typeName" in event ? workerEventJson(event) : JSON.stringify(event);
}
