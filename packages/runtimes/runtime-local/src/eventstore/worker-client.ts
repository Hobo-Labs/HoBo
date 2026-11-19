import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	EventEnvelope,
	EventInput,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
} from "@hobo/core";
import { StorageWorkerTerminatedError } from "@hobo/core";
import type { JsonValue } from "../json.js";
import type {
	StorageWorkerRequest,
	StorageWorkerResponse,
	StorageWorkerSuccess,
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
			op: StorageWorkerRequest["op"];
			resolve: (value: StorageWorkerSuccess) => void;
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
				if (msg.op !== slot.op) {
					slot.reject(
						new Error(`storage worker replied to ${slot.op} with ${msg.op}`),
					);
					return;
				}
				slot.resolve(msg);
			} else {
				const error = new Error(msg.error.message);
				error.name = msg.error.name;
				if (msg.error.code) Object.assign(error, { code: msg.error.code });
				slot.reject(error);
			}
		});
		worker.on("error", (error: Error) => {
			if (this.worker !== worker) return;
			this.worker = null;
			this.failAll(error);
		});
		worker.on("exit", (code) => {
			if (this.worker !== worker) return;
			this.worker = null;
			this.failAll(
				new StorageWorkerTerminatedError(
					`storage worker exited with code ${code}`,
				),
			);
		});
		this.worker = worker;
		return worker;
	}

	private failAll(error: Error): void {
		for (const slot of this.pending.values()) slot.reject(error);
		this.pending.clear();
	}

	private call(request: StorageWorkerRequest): Promise<StorageWorkerSuccess> {
		const worker = this.ensureWorker();
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, { op: request.op, resolve, reject });
			try {
				worker.postMessage(request);
			} catch (error) {
				this.pending.delete(request.id);
				reject(error);
			}
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
		const response = await this.call({
			id: this.nextId(),
			op: "append",
			streamId,
			events,
			options,
		});
		if (response.op !== "append")
			throw new TypeError("expected an append response");
		return response.result;
	}

	async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
		const response = await this.call({
			id: this.nextId(),
			op: "commit",
			request,
		});
		if (response.op !== "commit")
			throw new TypeError("expected a commit response");
		return response.result;
	}

	async read(streamId: string, fromSeq?: number): Promise<EventEnvelope[]> {
		const request: StorageWorkerRequest =
			fromSeq === undefined
				? { id: this.nextId(), op: "read", streamId }
				: { id: this.nextId(), op: "read", streamId, fromSeq };
		const response = await this.call(request);
		if (response.op !== "read") throw new TypeError("expected a read response");
		return response.result;
	}

	async readAll(options?: ReadAllOptions): Promise<PositionedEvent[]> {
		const request: StorageWorkerRequest =
			options === undefined
				? { id: this.nextId(), op: "readAll" }
				: { id: this.nextId(), op: "readAll", options };
		const response = await this.call(request);
		if (response.op !== "readAll")
			throw new TypeError("expected a readAll response");
		return response.result;
	}

	async snapshot(
		streamId: string,
		state: JsonValue,
		seq: number,
	): Promise<SnapshotRecord> {
		const response = await this.call({
			id: this.nextId(),
			op: "snapshot",
			streamId,
			state,
			seq,
		});
		if (response.op !== "snapshot")
			throw new TypeError("expected a snapshot response");
		return response.result;
	}

	async loadSnapshot(streamId: string): Promise<SnapshotRecord | undefined> {
		const response = await this.call({
			id: this.nextId(),
			op: "loadSnapshot",
			streamId,
		});
		if (response.op !== "loadSnapshot")
			throw new TypeError("expected a loadSnapshot response");
		return response.result ?? undefined;
	}

	async close(): Promise<void> {
		const worker = this.worker;
		if (!worker) return;
		try {
			await this.call({ id: this.nextId(), op: "shutdown" });
		} catch {}
		await worker.terminate();
		if (this.worker === worker) this.worker = null;
	}
}
