/**
 * Main-thread client for the storage worker. Serializes all ops through one
 * Worker so DatabaseSync never races and never monopolizes the event loop.
 */

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	EventEnvelope,
	EventInput,
	ReadAllOptions,
	SnapshotRecord,
} from "@hobo/core";
import { StorageWorkerTerminatedError } from "@hobo/core";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";

import type {
	StorageWorkerRequest,
	StorageWorkerResponse,
} from "./storage-worker.js";

export interface StorageWorkerClientOptions {
	readonly dbPath: string;
	readonly partitionId?: string;
}

export class StorageWorkerClient {
	private worker: Worker | null = null;
	private readonly pending = new Map<
		string,
		{
			resolve: (value: RevivedValue) => void;
			reject: (error: Error) => void;
		}
	>();
	private seq = 0;
	private readonly options: StorageWorkerClientOptions;

	constructor(options: StorageWorkerClientOptions) {
		this.options = options;
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const workerPath = fileURLToPath(
			new URL("./storage-worker.js", import.meta.url),
		);
		const worker = new Worker(workerPath, {
			workerData: {
				dbPath: this.options.dbPath,
				partitionId: this.options.partitionId,
			},
		});
		worker.on("message", (msg: StorageWorkerResponse) => {
			const slot = this.pending.get(msg.id);
			if (!slot) return;
			this.pending.delete(msg.id);
			if (msg.ok) {
				slot.resolve(reviveBigints(msg.result));
			} else {
				const err = new Error(msg.error.message);
				err.name = msg.error.name;
				if (msg.error.code) {
					Object.assign(err, { code: msg.error.code });
				}
				slot.reject(err);
			}
		});
		worker.on("error", (error: Error) => {
			this.failAll(error);
			this.worker = null;
		});
		worker.on("exit", (code) => {
			if (code !== 0) {
				this.failAll(
					new StorageWorkerTerminatedError(
						`storage worker exited with code ${code}`,
					),
				);
			}
			this.worker = null;
		});
		this.worker = worker;
		return worker;
	}

	private failAll(error: Error): void {
		for (const [, slot] of this.pending) {
			slot.reject(error);
		}
		this.pending.clear();
	}

	private call(request: StorageWorkerRequest): Promise<RevivedValue> {
		const worker = this.ensureWorker();
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
			worker.postMessage(request);
		});
	}

	private nextId(): string {
		return `req-${++this.seq}`;
	}

	async append(
		streamId: string,
		events: EventInput[],
		options: AppendOptions,
	): Promise<AppendResult> {
		const revived = await this.call({
			id: this.nextId(),
			op: "append",
			streamId,
			events,
			options,
		});
		// SAFETY: append worker payload is AppendResult after bigint revive.
		return revived as never;
	}

	async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
		const revived = await this.call({
			id: this.nextId(),
			op: "commit",
			request,
		});
		// SAFETY: commit worker payload is DurableCommitResult after bigint revive.
		return revived as never;
	}

	async read(streamId: string, fromSeq?: number): Promise<EventEnvelope[]> {
		const req: StorageWorkerRequest =
			fromSeq === undefined
				? { id: this.nextId(), op: "read", streamId }
				: { id: this.nextId(), op: "read", streamId, fromSeq };
		const revived = await this.call(req);
		// SAFETY: read worker payload is EventEnvelope[] after bigint revive.
		return revived as never;
	}

	async readAll(options?: ReadAllOptions): Promise<RevivedValue[]> {
		const req: StorageWorkerRequest =
			options === undefined
				? { id: this.nextId(), op: "readAll" }
				: { id: this.nextId(), op: "readAll", options };
		const revived = await this.call(req);
		if (!Array.isArray(revived)) {
			throw new TypeError("readAll worker payload must be an array");
		}
		return revived;
	}

	async snapshot(
		streamId: string,
		state: JsonValue,
		seq: number,
	): Promise<SnapshotRecord> {
		const revived = await this.call({
			id: this.nextId(),
			op: "snapshot",
			streamId,
			state,
			seq,
		});
		// SAFETY: snapshot worker payload is SnapshotRecord after bigint revive.
		return revived as never;
	}

	async loadSnapshot(streamId: string): Promise<SnapshotRecord | undefined> {
		const revived = await this.call({
			id: this.nextId(),
			op: "loadSnapshot",
			streamId,
		});
		if (revived === null) return undefined;
		// SAFETY: loadSnapshot worker payload is SnapshotRecord after bigint revive.
		return revived as never;
	}

	async close(): Promise<void> {
		if (!this.worker) return;
		try {
			await this.call({ id: this.nextId(), op: "shutdown" });
		} catch {
			// ignore
		}
		await this.worker.terminate();
		this.worker = null;
	}
}

export type RevivedValue = JsonValue | bigint | RevivedValue[] | RevivedBag;

export interface RevivedBag {
	[key: string]: RevivedValue;
}

function reviveBigints(value: JsonValue): RevivedValue {
	if (Array.isArray(value)) return value.map(reviveBigints);
	if (value && isJsonObject(value)) {
		if (
			Object.keys(value).length === 1 &&
			isJsonString(value.$bigint) &&
			/^-?\d+$/.test(value.$bigint)
		) {
			return BigInt(value.$bigint);
		}
		const out: RevivedBag = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = reviveBigints(v);
		}
		return out;
	}
	return value;
}
