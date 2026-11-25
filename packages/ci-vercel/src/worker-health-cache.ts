import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { RELAY_TTL, relayCacheKeys } from "@hobo/ci-gh-actions/relay-cache";
import type { EphemeralStatePort } from "@hobo/core";
import {
	type RelayWorkerHealth,
	RelayWorkerHealthSchema,
} from "./_generated/worker_health_pb.js";

const FRESH_MS = 45 * 60_000;
const COMPONENTS = ["repair", "repair-deliveries", "repair-queued"] as const;
export type RelayWorkerComponent = (typeof COMPONENTS)[number];
export type RelayWorkerStatus = "ok" | "starting" | "failing";

export type CacheWorkerHealthOptions = Readonly<{
	state: EphemeralStatePort;
	environment: string;
	deploymentId?: string | undefined;
	now?: () => number;
}>;

function scope(deploymentId: string | undefined): string {
	if (deploymentId === undefined) return "local";
	if (!/^dpl_[A-Za-z0-9]{1,128}$/u.test(deploymentId))
		throw new Error("invalid worker deployment ID");
	return deploymentId;
}

export class CacheWorkerHealth {
	private readonly keys: ReturnType<typeof relayCacheKeys>;
	private readonly scope: string;
	private readonly now: () => number;
	constructor(private readonly options: CacheWorkerHealthOptions) {
		this.keys = relayCacheKeys(options.environment);
		this.scope = scope(options.deploymentId);
		this.now = options.now ?? Date.now;
	}

	private async read(
		component: RelayWorkerComponent,
	): Promise<RelayWorkerHealth | undefined> {
		const entry = await this.options.state.get(
			this.keys.workerHealth(this.scope, component),
		);
		return entry
			? fromJsonString(RelayWorkerHealthSchema, entry.value)
			: undefined;
	}

	async mark(
		component: RelayWorkerComponent,
		ok: boolean,
		atMs = this.now(),
	): Promise<void> {
		const key = this.keys.workerHealth(this.scope, component);
		for (let attempt = 0; attempt < 8; attempt++) {
			const current = await this.options.state.get(key);
			const previous = current
				? fromJsonString(RelayWorkerHealthSchema, current.value)
				: create(RelayWorkerHealthSchema, { component });
			const next = create(RelayWorkerHealthSchema, {
				component,
				successAtMs: ok
					? Math.max(previous.successAtMs, atMs)
					: previous.successAtMs,
				failureAtMs: ok
					? previous.failureAtMs
					: Math.max(previous.failureAtMs, atMs),
			});
			if (
				current &&
				next.successAtMs === previous.successAtMs &&
				next.failureAtMs === previous.failureAtMs
			)
				return;
			const value = toJsonString(RelayWorkerHealthSchema, next);
			const write = current
				? await this.options.state.compareAndSet(
						key,
						current.version,
						value,
						RELAY_TTL.workerHealth,
					)
				: await this.options.state.putIfAbsent(
						key,
						value,
						RELAY_TTL.workerHealth,
					);
			if (write.applied) return;
		}
		throw new Error("worker health contended");
	}

	async startRepair(): Promise<string> {
		return new Date(this.now()).toISOString();
	}

	async finishRepair(
		index: number,
		ok: boolean,
		startedAt: string,
	): Promise<void> {
		const at = Date.parse(startedAt);
		if ((index !== 0 && index !== 1) || !Number.isFinite(at))
			throw new Error("invalid repair evidence");
		await this.mark(
			index === 0 ? "repair-deliveries" : "repair-queued",
			ok,
			at,
		);
	}

	async repairComplete(index: number): Promise<boolean> {
		if (index !== 0 && index !== 1) throw new Error("invalid repair index");
		const [scanner, tick] = await Promise.all([
			this.read(index === 0 ? "repair-deliveries" : "repair-queued"),
			this.read("repair"),
		]);
		return (
			!!scanner &&
			scanner.successAtMs > this.now() - FRESH_MS &&
			scanner.successAtMs > scanner.failureAtMs &&
			scanner.successAtMs > (tick?.failureAtMs ?? 0)
		);
	}

	async status(): Promise<
		Readonly<Record<RelayWorkerComponent, RelayWorkerStatus>>
	> {
		const records = await this.options.state.getMany(
			COMPONENTS.map((component) =>
				this.keys.workerHealth(this.scope, component),
			),
		);
		const statusOf = (index: number): RelayWorkerStatus => {
			const entry = records[index];
			if (!entry) return "starting";
			const record = fromJsonString(RelayWorkerHealthSchema, entry.value);
			return record.failureAtMs >= record.successAtMs ||
				record.successAtMs <= this.now() - FRESH_MS
				? "failing"
				: "ok";
		};
		return {
			repair: statusOf(0),
			"repair-deliveries": statusOf(1),
			"repair-queued": statusOf(2),
		};
	}

	async summary(): Promise<RelayWorkerStatus> {
		const statuses = Object.values(await this.status());
		return statuses.includes("failing")
			? "failing"
			: statuses.includes("starting")
				? "starting"
				: "ok";
	}
}
