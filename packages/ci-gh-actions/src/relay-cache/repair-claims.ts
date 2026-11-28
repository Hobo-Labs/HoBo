import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	acquireEphemeralLock,
	type EphemeralLockLease,
	type EphemeralStatePort,
	releaseEphemeralLock,
	renewEphemeralLock,
} from "@hobo/core";
import {
	type RelayCacheQueuedCursor,
	RelayCacheQueuedCursorSchema,
	type RelayCacheQueuedScan,
	RelayCacheQueuedScanSchema,
	RelayCacheWebhookScanSchema,
} from "../_generated/relay_cache_pb.js";
import type { QueuedRepairClaims } from "../queued-job-repair.js";
import type { WebhookRepairClaims } from "../webhook-repair.js";
import {
	decodeRecord,
	encodeRecord,
	RELAY_QUEUED_API_PER_MINUTE,
	RELAY_TTL,
	RELAY_WEBHOOK_REDELIVERIES_PER_MINUTE,
	type RelayCacheKeys,
	relayCacheKeys,
} from "./records.js";

const MINUTE = 60_000;
const APP_ID = /^[1-9]\d{0,15}$/u;

type QueuedScanHandle = Exclude<
	Awaited<ReturnType<QueuedRepairClaims["start"]>>,
	undefined | "busy" | "deferred"
>;
type QueuedCursor = QueuedScanHandle["cursor"];

export type RelayRepairClaimsOptions = Readonly<{
	state: EphemeralStatePort;
	environment: string;
	now?: () => number;
	owner?: string;
}>;

function appId(value: string): string {
	if (!APP_ID.test(value)) throw new Error("invalid GitHub App id");
	return value;
}

function windowStart(now: number): number {
	return Math.floor(now / MINUTE) * MINUTE;
}

function owner(options: RelayRepairClaimsOptions): string {
	return options.owner ?? `relay:${randomUUID()}`;
}

class ScanLock {
	constructor(
		private readonly state: EphemeralStatePort,
		private lease: EphemeralLockLease,
	) {}
	static async take(
		state: EphemeralStatePort,
		keys: RelayCacheKeys,
		scanner: "webhook" | "queued",
		app: string,
		token: string,
	): Promise<ScanLock | undefined> {
		const lease = await acquireEphemeralLock(
			state,
			keys.repairLock(scanner, app),
			token,
			RELAY_TTL.scanLock,
		);
		return lease ? new ScanLock(state, lease) : undefined;
	}
	async renew(): Promise<void> {
		const renewed = await renewEphemeralLock(
			this.state,
			this.lease,
			RELAY_TTL.scanLock,
		);
		if (!renewed) throw new Error("repair scan lock lost");
		this.lease = renewed;
	}
	async release(): Promise<void> {
		await releaseEphemeralLock(this.state, this.lease);
	}
}

async function upsert(
	state: EphemeralStatePort,
	key: Parameters<EphemeralStatePort["get"]>[0],
	value: string,
	ttl: Parameters<EphemeralStatePort["putIfAbsent"]>[2],
): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const current = await state.get(key);
		const write = current
			? await state.compareAndSet(key, current.version, value, ttl)
			: await state.putIfAbsent(key, value, ttl);
		if (write.applied) return;
	}
	throw new Error("repair cursor contended");
}

export class CacheWebhookRepairClaims implements WebhookRepairClaims {
	private readonly keys: RelayCacheKeys;
	private readonly now: () => number;
	private readonly token: string;
	constructor(private readonly options: RelayRepairClaimsOptions) {
		this.keys = relayCacheKeys(options.environment);
		this.now = options.now ?? Date.now;
		this.token = owner(options);
	}

	async claim(app: string, guid: string, now: number): Promise<boolean> {
		const { state } = this.options;
		const claimed = await state.putIfAbsent(
			this.keys.webhookClaim(appId(app), guid),
			String(now),
			RELAY_TTL.webhookClaim,
		);
		if (!claimed.applied) return false;
		const used = await state.increment(
			this.keys.webhookRedeliveries(app, windowStart(now)),
			1,
			RELAY_TTL.minuteWindow,
			"on-create",
		);
		if (used <= RELAY_WEBHOOK_REDELIVERIES_PER_MINUTE) return true;
		await state.delete(this.keys.webhookClaim(app, guid), claimed.version);
		return false;
	}

	async limited(app: string, now: number): Promise<boolean> {
		const entry = await this.options.state.get(
			this.keys.webhookRedeliveries(appId(app), windowStart(now)),
		);
		return Number(entry?.value ?? 0) >= RELAY_WEBHOOK_REDELIVERIES_PER_MINUTE;
	}

	async recordSuccesses(app: string, guids: string[], now: number) {
		const unique = [...new Set(guids)];
		if (unique.length === 0) return;
		const { state } = this.options;
		const keys = unique.map((guid) =>
			this.keys.webhookSuccess(appId(app), guid),
		);
		const known = await state.getMany(keys);
		for (const [index, key] of keys.entries())
			if (!known[index])
				await state.putIfAbsent(key, String(now), RELAY_TTL.webhookSuccess);
	}

	async wasSuccessful(app: string, guid: string): Promise<boolean> {
		return (
			(await this.options.state.get(
				this.keys.webhookSuccess(appId(app), guid),
			)) !== undefined
		);
	}

	async startScan(app: string) {
		const { state } = this.options;
		const lock = await ScanLock.take(
			state,
			this.keys,
			"webhook",
			appId(app),
			this.token,
		);
		if (!lock) return undefined;
		try {
			const entry = await state.get(this.keys.webhookCursor(app));
			const cursor = entry
				? decodeRecord(RelayCacheWebhookScanSchema, entry.value).cursorUrl ||
					undefined
				: undefined;
			let closed = false;
			return {
				cursor,
				checkpoint: async (next: string | undefined) => {
					await lock.renew();
					if (next === undefined) {
						await state.delete(this.keys.webhookCursor(app));
						return;
					}
					await upsert(
						state,
						this.keys.webhookCursor(app),
						encodeRecord(
							RelayCacheWebhookScanSchema,
							create(RelayCacheWebhookScanSchema, {
								cursorUrl: next,
								checkpointAt: new Date(this.now()).toISOString(),
							}),
						),
						RELAY_TTL.webhookCursor,
					);
				},
				close: async () => {
					if (closed) return;
					closed = true;
					await lock.release();
				},
			};
		} catch (error) {
			await lock.release().catch(() => undefined);
			throw error;
		}
	}
}

function toCursor(record: RelayCacheQueuedCursor | undefined): QueuedCursor {
	return {
		page: record?.page || 1,
		runs: [...(record?.runs ?? [])],
		loaded: record?.loaded ?? false,
		hasNext: record?.hasNext ?? false,
		runIndex: record?.runIndex ?? 0,
		jobPage: record?.jobPage || 1,
		jobIndex: record?.jobIndex ?? 0,
	};
}

function fromCursor(cursor: QueuedCursor): RelayCacheQueuedCursor {
	return create(RelayCacheQueuedCursorSchema, {
		page: cursor.page,
		runs: [...cursor.runs],
		loaded: cursor.loaded,
		hasNext: cursor.hasNext,
		runIndex: cursor.runIndex,
		jobPage: cursor.jobPage,
		jobIndex: cursor.jobIndex,
	});
}

export class CacheQueuedJobRepairClaims implements QueuedRepairClaims {
	private readonly keys: RelayCacheKeys;
	private readonly now: () => number;
	private readonly token: string;
	private readonly app: string;
	constructor(
		private readonly options: RelayRepairClaimsOptions & { appId: string },
	) {
		this.keys = relayCacheKeys(options.environment);
		this.now = options.now ?? Date.now;
		this.token = owner(options);
		this.app = appId(options.appId);
	}

	async start(scanKeys: readonly string[]) {
		if (scanKeys.length === 0) return undefined;
		const { state } = this.options;
		const lock = await ScanLock.take(
			state,
			this.keys,
			"queued",
			this.app,
			this.token,
		);
		if (!lock) return "busy" as const;
		try {
			const keys = scanKeys.map((scanKey) =>
				this.keys.queuedScan(this.app, scanKey),
			);
			const entries = await state.getMany(keys);
			const scans = new Map<string, RelayCacheQueuedScan>();
			for (const [index, scanKey] of scanKeys.entries()) {
				const entry = entries[index];
				scans.set(
					scanKey,
					entry
						? decodeRecord(RelayCacheQueuedScanSchema, entry.value)
						: create(RelayCacheQueuedScanSchema, {}),
				);
			}
			const now = this.now();
			const dueWithin = (ms: number) =>
				[...scans.values()].some((scan) => scan.dueMs <= this.now() + ms);
			const chosen = [...scans.entries()]
				.filter(([, scan]) => scan.dueMs <= now)
				.sort(
					([aKey, a], [bKey, b]) =>
						a.touchedMs - b.touchedMs || aKey.localeCompare(bKey),
				)[0];
			if (!chosen) {
				const deferred = dueWithin(MINUTE);
				await lock.release();
				return deferred ? ("deferred" as const) : undefined;
			}
			const [scanKey, scan] = chosen;
			let closed = false;
			const handle: QueuedScanHandle = {
				key: scanKey,
				cursor: toCursor(scan.cursor),
				take: async (count: number) => {
					if (!Number.isInteger(count) || count < 1 || count > 10)
						throw new Error("invalid API budget");
					const key = this.keys.queuedBudget(this.app, windowStart(this.now()));
					const used = await state.increment(
						key,
						count,
						RELAY_TTL.minuteWindow,
						"on-create",
					);
					if (used <= RELAY_QUEUED_API_PER_MINUTE) return true;
					await state.increment(
						key,
						-count,
						RELAY_TTL.minuteWindow,
						"on-create",
					);
					return false;
				},
				checkpoint: async (cursor: QueuedCursor, dueMs: number) => {
					if (!Number.isInteger(dueMs) || dueMs < 0 || dueMs > 900_000)
						throw new Error("invalid scan delay");
					await lock.renew();
					const at = this.now();
					const next = create(RelayCacheQueuedScanSchema, {
						cursor: fromCursor(cursor),
						dueMs: at + dueMs,
						touchedMs: at,
					});
					scans.set(scanKey, next);
					await upsert(
						state,
						this.keys.queuedScan(this.app, scanKey),
						encodeRecord(RelayCacheQueuedScanSchema, next),
						RELAY_TTL.queuedScan,
					);
				},
				more: async () => dueWithin(MINUTE),
				close: async () => {
					if (closed) return;
					closed = true;
					await lock.release();
				},
			};
			return handle;
		} catch (error) {
			await lock.release().catch(() => undefined);
			throw error;
		}
	}
}
