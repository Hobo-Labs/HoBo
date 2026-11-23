/**
 * In-memory control-plane reference model. Provider simulators only.
 * Drives `@hobo/bindles` parse/hash; apply/retry/destroy live in this ledger.
 */

// public-contract: property-oracle record schema id
export const FUZZ_INVARIANT_SCHEMA = "hobo.fuzz.invariant-verdict/v1" as const;
// public-contract: property-oracle trace schema id
export const FUZZ_TRACE_SCHEMA = "hobo.fuzz.trace/v1" as const;

const REPLAY_OWNED_EVENT_KINDS = new Set([
	"clock.advanced",
	"clock.set",
	"snapshot.taken",
	"rollback",
	"model.restored",
	"bindle.created",
	"capability.added",
	"capability.attenuated",
	"resource.applied",
	"resource.interrupted",
	"bindle.destroyed",
]);

export const ALL_VERBS = [
	"get",
	"set",
	"delete",
	"read",
	"write",
	"query",
] as const;
export type Verb = (typeof ALL_VERBS)[number];

export type ResourceStatus =
	| "desired"
	| "applying"
	| "ready"
	| "failed"
	| "destroyed";

export interface OwnedResource {
	readonly id: string;
	readonly tenantId: string;
	readonly bindleId: string;
	readonly idempotencyKey: string;
	readonly createdAt: number;
	status: ResourceStatus;
	applyCount: number;
}

export interface Capability {
	readonly id: string;
	readonly tenantId: string;
	verbs: readonly Verb[];
}

export interface BindleSlot {
	readonly id: string;
	readonly tenantId: string;
	readonly manifestHash: string;
	readonly createdAt: number;
}

export interface ModelEvent {
	readonly seq: number;
	readonly tenantId: string;
	readonly kind: string;
	readonly payload: Readonly<Record<string, string>>;
}

// domain-view: parsed invariant verdict; wire form is InvariantVerdict in data-models/fuzz.proto
export interface InvariantVerdict {
	readonly schema: typeof FUZZ_INVARIANT_SCHEMA;
	readonly invariant: string;
	readonly ok: boolean;
	readonly message: string;
}

export type OpResult = { ok: true } | { ok: false; reason: string };

type SnapshotBlob = {
	clock: number;
	fingerprint: string;
	bindles: Array<[string, BindleSlot]>;
	capabilities: Array<[string, Capability]>;
	resources: Array<[string, OwnedResource]>;
};

export type ModelCommand =
	| {
			kind: "createBindle";
			tenantId: string;
			bindleId: string;
			manifestHash: string;
	  }
	| {
			kind: "addCapability";
			tenantId: string;
			capabilityId: string;
			verbs: readonly Verb[];
	  }
	| {
			kind: "attenuate";
			tenantId: string;
			capabilityId: string;
			keep: readonly Verb[];
	  }
	| {
			kind: "resolveProvider";
			tenantId: string;
			bindleId: string;
			provider: string;
	  }
	| { kind: "plan"; tenantId: string; bindleId: string }
	| {
			kind: "apply";
			tenantId: string;
			bindleId: string;
			idempotencyKey: string;
			fail?: boolean;
	  }
	| {
			kind: "retryApply";
			tenantId: string;
			bindleId: string;
			idempotencyKey: string;
	  }
	| { kind: "interruptApply"; tenantId: string; idempotencyKey: string }
	| { kind: "reconcile"; tenantId: string; bindleId: string }
	| {
			kind: "migrateProvider";
			tenantId: string;
			bindleId: string;
			provider: string;
	  }
	| { kind: "changeTenant"; bindleId: string; toTenantId: string }
	| { kind: "rotateSecretRef"; tenantId: string; bindleId: string }
	| { kind: "snapshot" }
	| { kind: "rollback"; tenantId: string; targetClock?: number }
	| { kind: "destroy"; tenantId: string; bindleId: string };

export class ControlModel {
	#clock = 0;
	#bindles = new Map<string, BindleSlot>();
	#capabilities = new Map<string, Capability>();
	#resources = new Map<string, OwnedResource>();
	#eventLog: ModelEvent[] = [];
	#snapshots = new Map<number, string>();
	#lastRollbackTarget: number | null = null;
	#replayBaseline: string | undefined;

	get lastRollbackTarget(): number | null {
		return this.#lastRollbackTarget;
	}

	get clock(): number {
		return this.#clock;
	}

	set clock(value: number) {
		if (!Number.isSafeInteger(value) || value < 0 || value < this.#clock) {
			throw new Error("fuzz.invalid_model_clock");
		}
		if (value === this.#clock) return;
		this.#clock = value;
		this.#appendEvent("system", "clock.set", { value: String(value) });
	}

	get bindles(): Map<string, BindleSlot> {
		return new Map([...this.#bindles].map(([id, row]) => [id, { ...row }]));
	}

	get capabilities(): Map<string, Capability> {
		return new Map(
			[...this.#capabilities].map(([id, row]) => [
				id,
				{ ...row, verbs: [...row.verbs] },
			]),
		);
	}

	get resources(): Map<string, OwnedResource> {
		return new Map([...this.#resources].map(([id, row]) => [id, { ...row }]));
	}

	get snapshots(): Map<number, string> {
		return new Map(this.#snapshots);
	}

	get events(): ModelEvent[] {
		return this.#eventLog.map((event) => ({
			...event,
			payload: { ...event.payload },
		}));
	}

	tick(): number {
		const next = this.#advanceClock();
		this.#appendEvent("system", "clock.advanced", {});
		return next;
	}

	#advanceClock(): number {
		if (
			!Number.isSafeInteger(this.#clock) ||
			this.#clock < 0 ||
			this.#clock >= Number.MAX_SAFE_INTEGER
		) {
			throw new Error("fuzz.model_clock_exhausted");
		}
		this.#clock += 1;
		return this.#clock;
	}

	append(
		tenantId: string,
		kind: string,
		payload: Record<string, string>,
	): void {
		this.note(tenantId, kind, payload);
	}

	#appendEvent(
		tenantId: string,
		kind: string,
		payload: Record<string, string>,
	): void {
		this.#eventLog.push({
			seq: this.#eventLog.length,
			tenantId,
			kind,
			payload: { ...payload },
		});
	}

	snapshot(): number {
		const at = this.clock;
		this.#snapshots.set(at, this.serialize());
		this.#appendEvent("system", "snapshot.taken", { at: String(at) });
		return at;
	}

	serialize(): string {
		const blob: SnapshotBlob = {
			clock: this.clock,
			fingerprint: this.fingerprint(),
			bindles: [...this.#bindles.entries()],
			capabilities: [...this.#capabilities.entries()],
			resources: [...this.#resources.entries()].map(([id, row]) => [
				id,
				{ ...row },
			]),
		};
		return JSON.stringify(blob);
	}

	restore(raw: string): void {
		const blob = parseSnapshot(raw);
		const candidate = new ControlModel();
		for (const [id, row] of blob.bindles) candidate.#bindles.set(id, row);
		for (const [id, row] of blob.capabilities)
			candidate.#capabilities.set(id, row);
		for (const [id, row] of blob.resources) candidate.#resources.set(id, row);
		if (candidate.fingerprint() !== blob.fingerprint) {
			throw new Error("fuzz.invalid_snapshot");
		}
		const pristine =
			this.clock === 0 &&
			this.#eventLog.length === 0 &&
			this.#snapshots.size === 0 &&
			this.#bindles.size === 0 &&
			this.#capabilities.size === 0 &&
			this.#resources.size === 0 &&
			this.#lastRollbackTarget === null &&
			this.#replayBaseline === undefined;
		if (!Number.isSafeInteger(this.clock) || this.clock < 0) {
			throw new Error("fuzz.model_clock_exhausted");
		}
		const baseClock = Math.max(this.clock, blob.clock);
		if (!pristine && baseClock >= Number.MAX_SAFE_INTEGER) {
			throw new Error("fuzz.model_clock_exhausted");
		}
		this.#clock = pristine ? blob.clock : baseClock + 1;
		this.#bindles.clear();
		this.#capabilities.clear();
		this.#resources.clear();
		for (const [id, row] of blob.bindles) this.#bindles.set(id, row);
		for (const [id, row] of blob.capabilities) this.#capabilities.set(id, row);
		for (const [id, row] of blob.resources) this.#resources.set(id, row);
		if (pristine) this.#replayBaseline = raw;
		else this.#appendEvent("system", "model.restored", { snapshot: raw });
	}

	fingerprint(tenantId?: string): string {
		const bindles = [...this.#bindles.values()]
			.filter((row) => tenantId === undefined || row.tenantId === tenantId)
			.map((row) => `${row.id}:${row.manifestHash}`)
			.sort();
		const caps = [...this.#capabilities.values()]
			.filter((row) => tenantId === undefined || row.tenantId === tenantId)
			.map((row) => `${row.id}:${[...row.verbs].sort().join(",")}`)
			.sort();
		const resources = [...this.#resources.values()]
			.filter(
				(row) =>
					row.status !== "destroyed" &&
					(tenantId === undefined || row.tenantId === tenantId),
			)
			.map((row) => `${row.idempotencyKey}:${row.id}:${row.status}`)
			.sort();
		return `${bindles.join("|")}#${caps.join("|")}#${resources.join("|")}`;
	}

	ownedCount(tenantId?: string): number {
		return [...this.#resources.values()].filter(
			(row) =>
				row.status !== "destroyed" &&
				(tenantId === undefined || row.tenantId === tenantId),
		).length;
	}

	createBindle(
		tenantId: string,
		bindleId: string,
		manifestHash: string,
	): OpResult {
		const existing = this.#bindles.get(bindleId);
		const foreignResource = [...this.#resources.values()].some(
			(row) =>
				row.bindleId === bindleId &&
				row.status !== "destroyed" &&
				row.tenantId !== tenantId,
		);
		if ((existing && existing.tenantId !== tenantId) || foreignResource) {
			this.#advanceClock();
			this.#appendEvent(tenantId, "bindle.create-refused", {
				bindleId,
				reason: "owned-by-other-tenant",
			});
			return { ok: false, reason: "owned-by-other-tenant" };
		}
		const createdAt = this.#advanceClock();
		this.#bindles.set(bindleId, {
			id: bindleId,
			tenantId,
			manifestHash,
			createdAt,
		});
		this.#appendEvent(tenantId, "bindle.created", { bindleId, manifestHash });
		return { ok: true };
	}

	addCapability(
		tenantId: string,
		capabilityId: string,
		verbs: readonly Verb[],
	): void {
		const captured = captureVerbs(verbs);
		const existing = this.#capabilities.get(capabilityId);
		if (existing && existing.tenantId !== tenantId) {
			this.#advanceClock();
			this.#appendEvent(tenantId, "capability.add-refused", { capabilityId });
			return;
		}
		this.#advanceClock();
		this.#capabilities.set(capabilityId, {
			id: capabilityId,
			tenantId,
			verbs: captured,
		});
		this.#appendEvent(tenantId, "capability.added", {
			capabilityId,
			verbs: captured.join(","),
		});
	}

	attenuate(
		tenantId: string,
		capabilityId: string,
		keep: readonly Verb[],
	): void {
		const captured = captureVerbs(keep);
		const cap = this.#capabilities.get(capabilityId);
		if (!cap) return;
		if (cap.tenantId !== tenantId) {
			this.#advanceClock();
			this.#appendEvent(tenantId, "capability.attenuate-refused", {
				capabilityId,
			});
			return;
		}
		this.#advanceClock();
		const allowed = new Set(cap.verbs);
		cap.verbs = captured.filter((verb) => allowed.has(verb));
		this.#appendEvent(cap.tenantId, "capability.attenuated", {
			capabilityId,
			verbs: cap.verbs.join(","),
		});
	}

	note(tenantId: string, kind: string, payload: Record<string, string>): void {
		if (REPLAY_OWNED_EVENT_KINDS.has(kind)) {
			throw new Error("fuzz.reserved_event_kind");
		}
		const captured = captureEventPayload(payload);
		this.#advanceClock();
		this.#appendEvent(tenantId, kind, captured);
	}

	apply(
		tenantId: string,
		bindleId: string,
		idempotencyKey: string,
		opts: { fail?: boolean } = {},
	): OwnedResource {
		const bindle = this.#bindles.get(bindleId);
		if (!bindle || bindle.tenantId !== tenantId) {
			this.#advanceClock();
			this.#appendEvent(tenantId, "resource.apply-refused", {
				bindleId,
				idempotencyKey,
				reason: bindle ? "owned-by-other-tenant" : "missing-bindle",
			});
			return {
				id: `refused-${this.clock}`,
				tenantId,
				bindleId,
				idempotencyKey,
				createdAt: this.clock,
				status: "failed",
				applyCount: 0,
			};
		}
		const existing = [...this.#resources.values()].find(
			(row) =>
				row.idempotencyKey === idempotencyKey &&
				row.tenantId === tenantId &&
				row.status !== "destroyed",
		);
		if (existing) {
			this.#advanceClock();
			existing.applyCount += 1;
			if (opts.fail !== true && existing.status === "failed") {
				existing.status = "ready";
			} else if (opts.fail === true) {
				existing.status = "failed";
			}
			this.#appendEvent(tenantId, "resource.applied", {
				id: existing.id,
				bindleId: existing.bindleId,
				idempotencyKey,
				retry: "true",
				status: existing.status,
			});
			return { ...existing };
		}
		const createdAt = this.#advanceClock();
		const resource: OwnedResource = {
			id: `res-${tenantId}-${idempotencyKey}`,
			tenantId,
			bindleId,
			idempotencyKey,
			createdAt,
			status: opts.fail === true ? "failed" : "ready",
			applyCount: 1,
		};
		this.#resources.set(resource.id, resource);
		this.#appendEvent(tenantId, "resource.applied", {
			id: resource.id,
			bindleId,
			idempotencyKey,
			retry: "false",
			status: resource.status,
		});
		return { ...resource };
	}

	findByKey(
		tenantId: string,
		idempotencyKey: string,
	): OwnedResource | undefined {
		const resource = this.#findByKey(tenantId, idempotencyKey);
		return resource ? { ...resource } : undefined;
	}

	#findByKey(
		tenantId: string,
		idempotencyKey: string,
	): OwnedResource | undefined {
		return [...this.#resources.values()].find(
			(row) =>
				row.tenantId === tenantId &&
				row.status !== "destroyed" &&
				(row.idempotencyKey === idempotencyKey || row.id === idempotencyKey),
		);
	}

	interruptApply(tenantId: string, idempotencyKey: string): void {
		const resource = this.#findByKey(tenantId, idempotencyKey);
		if (!resource) return;
		this.#advanceClock();
		resource.status = "failed";
		this.#appendEvent(tenantId, "resource.interrupted", {
			id: resource.id,
			idempotencyKey: resource.idempotencyKey,
		});
	}

	destroy(tenantId: string, bindleId: string): OpResult {
		const bindle = this.#bindles.get(bindleId);
		if (bindle && bindle.tenantId !== tenantId) {
			this.#advanceClock();
			this.#appendEvent(tenantId, "bindle.destroy-refused", {
				bindleId,
				reason: "owned-by-other-tenant",
			});
			return { ok: false, reason: "owned-by-other-tenant" };
		}
		this.#advanceClock();
		for (const resource of this.#resources.values()) {
			if (resource.tenantId === tenantId && resource.bindleId === bindleId) {
				resource.status = "destroyed";
			}
		}
		this.#appendEvent(tenantId, "bindle.destroyed", { bindleId });
		return { ok: true };
	}

	rollback(tenantId: string, targetClock: number): InvariantVerdict {
		const shot = this.#snapshots.get(targetClock);
		if (shot === undefined) {
			return verdict(
				"rollback-not-newer",
				true,
				"no snapshot at target; rollback is a no-op",
			);
		}
		// SAFETY: snapshot values are produced by serialize() in this model.
		const blob = JSON.parse(shot) as SnapshotBlob;
		const expected = tenantFingerprint(blob, tenantId);
		this.#advanceClock();
		this.#restoreTenant(tenantId, blob);
		this.#lastRollbackTarget = targetClock;
		this.#appendEvent(tenantId, "rollback", { target: String(targetClock) });
		const restored = this.fingerprint(tenantId);
		const ok = restored === expected;
		return verdict(
			"rollback-not-newer",
			ok,
			ok
				? "tenant rollback restored the snapshot slice"
				: `tenant rollback drifted: ${restored} vs ${expected}`,
		);
	}

	#restoreTenant(tenantId: string, blob: SnapshotBlob): void {
		for (const [id, row] of this.#bindles.entries()) {
			if (row.tenantId === tenantId) this.#bindles.delete(id);
		}
		for (const [id, row] of this.#capabilities.entries()) {
			if (row.tenantId === tenantId) this.#capabilities.delete(id);
		}
		for (const [id, row] of this.#resources.entries()) {
			if (row.tenantId === tenantId) this.#resources.delete(id);
		}
		for (const [id, row] of blob.bindles) {
			if (row.tenantId === tenantId) this.#bindles.set(id, row);
		}
		for (const [id, row] of blob.capabilities) {
			if (row.tenantId === tenantId) {
				this.#capabilities.set(id, { ...row, verbs: [...row.verbs] });
			}
		}
		for (const [id, row] of blob.resources) {
			if (row.tenantId === tenantId) this.#resources.set(id, { ...row });
		}
	}

	changeTenant(bindleId: string, toTenantId: string): void {
		const bindle = this.#bindles.get(bindleId);
		this.#advanceClock();
		this.#appendEvent(bindle?.tenantId ?? "system", "tenant.change-refused", {
			bindleId,
			toTenantId,
			reason: "cross-tenant move is fail-closed in the reference model",
		});
	}

	applyCommand(command: ModelCommand): InvariantVerdict | undefined {
		switch (command.kind) {
			case "createBindle":
				this.createBindle(
					command.tenantId,
					command.bindleId,
					command.manifestHash,
				);
				return undefined;
			case "addCapability":
				this.addCapability(
					command.tenantId,
					command.capabilityId,
					command.verbs,
				);
				return undefined;
			case "attenuate":
				this.attenuate(command.tenantId, command.capabilityId, command.keep);
				return undefined;
			case "resolveProvider":
				this.note(command.tenantId, "provider.resolved", {
					bindleId: command.bindleId,
					provider: command.provider,
				});
				return undefined;
			case "plan":
				this.note(command.tenantId, "plan.computed", {
					bindleId: command.bindleId,
				});
				return undefined;
			case "apply":
				this.apply(
					command.tenantId,
					command.bindleId,
					command.idempotencyKey,
					command.fail === true ? { fail: true } : {},
				);
				return undefined;
			case "retryApply":
				this.apply(command.tenantId, command.bindleId, command.idempotencyKey);
				return undefined;
			case "interruptApply":
				this.interruptApply(command.tenantId, command.idempotencyKey);
				return undefined;
			case "reconcile":
				this.note(command.tenantId, "resource.reconciled", {
					bindleId: command.bindleId,
				});
				return undefined;
			case "migrateProvider":
				this.note(command.tenantId, "provider.migrated", {
					bindleId: command.bindleId,
					provider: command.provider,
				});
				return undefined;
			case "changeTenant":
				this.changeTenant(command.bindleId, command.toTenantId);
				return undefined;
			case "rotateSecretRef":
				this.note(command.tenantId, "secret.rotated", {
					bindleId: command.bindleId,
				});
				return undefined;
			case "snapshot":
				this.snapshot();
				return undefined;
			case "rollback": {
				const target =
					command.targetClock ??
					[...this.#snapshots.keys()].sort((a, b) => a - b)[0];
				if (target === undefined) return undefined;
				return this.rollback(command.tenantId, target);
			}
			case "destroy":
				this.destroy(command.tenantId, command.bindleId);
				return undefined;
		}
	}

	replay(): string {
		const copy = new ControlModel();
		if (this.#replayBaseline !== undefined) copy.restore(this.#replayBaseline);
		for (const event of this.#eventLog) {
			if (event.kind === "clock.advanced") {
				copy.tick();
			} else if (event.kind === "clock.set") {
				copy.clock = Number(event.payload.value);
			} else if (event.kind === "snapshot.taken") {
				copy.snapshot();
			} else if (event.kind === "rollback") {
				copy.rollback(event.tenantId, Number(event.payload.target));
			} else if (event.kind === "model.restored") {
				copy.restore(event.payload.snapshot ?? "");
			} else if (event.kind === "bindle.created") {
				copy.createBindle(
					event.tenantId,
					event.payload.bindleId ?? "",
					event.payload.manifestHash ?? "",
				);
			} else if (event.kind === "capability.added") {
				const verbs = parseVerbs(event.payload.verbs);
				copy.addCapability(
					event.tenantId,
					event.payload.capabilityId ?? "",
					verbs,
				);
			} else if (event.kind === "capability.attenuated") {
				copy.attenuate(
					event.tenantId,
					event.payload.capabilityId ?? "",
					parseVerbs(event.payload.verbs),
				);
			} else if (event.kind === "resource.applied") {
				copy.apply(
					event.tenantId,
					event.payload.bindleId ?? "replay",
					event.payload.idempotencyKey ?? event.payload.id ?? "",
					{ fail: event.payload.status === "failed" },
				);
			} else if (event.kind === "resource.interrupted") {
				copy.interruptApply(
					event.tenantId,
					event.payload.idempotencyKey ?? event.payload.id ?? "",
				);
			} else if (event.kind === "bindle.destroyed") {
				copy.destroy(event.tenantId, event.payload.bindleId ?? "");
			} else {
				copy.note(event.tenantId, event.kind, { ...event.payload });
			}
		}
		return copy.fingerprint();
	}
}

function invalidSnapshot(): never {
	throw new Error("fuzz.invalid_snapshot");
}

type SnapshotJson =
	| null
	| boolean
	| number
	| string
	| SnapshotJson[]
	| { [key: string]: SnapshotJson };
type SnapshotObject = { [key: string]: SnapshotJson };

function snapshotRecord(value: SnapshotJson | undefined): SnapshotObject {
	if (
		value === null ||
		value === undefined ||
		Object(value) !== value ||
		Array.isArray(value)
	) {
		return invalidSnapshot();
	}
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON objects are the only non-array object values in SnapshotJson.
	return value as SnapshotObject;
}

function snapshotString(value: SnapshotJson | undefined): string {
	if (value?.constructor !== String) return invalidSnapshot();
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON has no boxed strings; constructor identity selects a string.
	return value as string;
}

function snapshotInteger(value: SnapshotJson | undefined): number {
	if (value?.constructor !== Number) return invalidSnapshot();
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON has no boxed numbers; constructor identity selects a number.
	const number = value as number;
	if (!Number.isSafeInteger(number) || number < 0) {
		return invalidSnapshot();
	}
	return number;
}

function snapshotRows<T extends { id: string }>(
	value: SnapshotJson | undefined,
	parseRow: (row: SnapshotObject) => T,
): Array<[string, T]> {
	if (!Array.isArray(value)) return invalidSnapshot();
	const seen = new Set<string>();
	return value.map((entry): [string, T] => {
		if (!Array.isArray(entry) || entry.length !== 2) return invalidSnapshot();
		const id = snapshotString(entry[0]);
		const row = parseRow(snapshotRecord(entry[1]));
		if (row.id !== id || seen.has(id)) return invalidSnapshot();
		seen.add(id);
		return [id, row];
	});
}

function isVerb(value: SnapshotJson | undefined): value is Verb {
	return (
		value?.constructor === String && ALL_VERBS.some((verb) => verb === value)
	);
}

function captureVerbs(verbs: readonly Verb[]): Verb[] {
	if (!Array.isArray(verbs)) throw new Error("fuzz.invalid_verbs");
	const captured = [...verbs];
	if (!captured.every(isVerb)) throw new Error("fuzz.invalid_verbs");
	return captured;
}

function captureEventPayload(payload: Record<string, string>) {
	if (!payload || Object(payload) !== payload || Array.isArray(payload)) {
		throw new Error("fuzz.invalid_event_payload");
	}
	const prototype = Object.getPrototypeOf(payload);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error("fuzz.invalid_event_payload");
	}
	const captured = { ...payload };
	if (
		!Object.values(captured).every(
			(value) => value?.constructor === String && Object(value) !== value,
		)
	) {
		throw new Error("fuzz.invalid_event_payload");
	}
	return captured;
}

function isResourceStatus(
	value: SnapshotJson | undefined,
): value is ResourceStatus {
	return (
		value === "desired" ||
		value === "applying" ||
		value === "ready" ||
		value === "failed" ||
		value === "destroyed"
	);
}

function parseSnapshot(raw: string): SnapshotBlob {
	let input: SnapshotJson;
	try {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: JSON.parse produces a value in the SnapshotJson union.
		input = JSON.parse(raw) as SnapshotJson;
	} catch {
		return invalidSnapshot();
	}
	const value = snapshotRecord(input);
	const bindles = snapshotRows(value.bindles, (row) => ({
		id: snapshotString(row.id),
		tenantId: snapshotString(row.tenantId),
		manifestHash: snapshotString(row.manifestHash),
		createdAt: snapshotInteger(row.createdAt),
	}));
	const capabilities = snapshotRows(value.capabilities, (row) => {
		if (!Array.isArray(row.verbs) || !row.verbs.every(isVerb)) {
			return invalidSnapshot();
		}
		return {
			id: snapshotString(row.id),
			tenantId: snapshotString(row.tenantId),
			verbs: [...row.verbs],
		};
	});
	const resources = snapshotRows(value.resources, (row): OwnedResource => {
		if (!isResourceStatus(row.status)) return invalidSnapshot();
		return {
			id: snapshotString(row.id),
			tenantId: snapshotString(row.tenantId),
			bindleId: snapshotString(row.bindleId),
			idempotencyKey: snapshotString(row.idempotencyKey),
			createdAt: snapshotInteger(row.createdAt),
			status: row.status,
			applyCount: snapshotInteger(row.applyCount),
		};
	});
	return {
		clock: snapshotInteger(value.clock),
		fingerprint: snapshotString(value.fingerprint),
		bindles,
		capabilities,
		resources,
	};
}

function tenantFingerprint(blob: SnapshotBlob, tenantId: string): string {
	const scratch = new ControlModel();
	scratch.restore(JSON.stringify(blob));
	return scratch.fingerprint(tenantId);
}

function parseVerbs(raw: string | undefined): Verb[] {
	return (raw ?? "").split(",").filter((verb): verb is Verb =>
		// SAFETY: ALL_VERBS is the runtime source for the Verb union.
		(ALL_VERBS as readonly string[]).includes(verb),
	);
}

export function verdict(
	invariant: string,
	ok: boolean,
	message: string,
): InvariantVerdict {
	return { schema: FUZZ_INVARIANT_SCHEMA, invariant, ok, message };
}

export function checkInvariants(world: ControlModel): InvariantVerdict[] {
	const byKey = new Map<string, OwnedResource[]>();
	const resources = [...world.resources.values()];
	const bindles = world.bindles;
	for (const resource of resources) {
		if (resource.status === "destroyed") continue;
		const key = `${resource.tenantId}:${resource.idempotencyKey}`;
		const bag = byKey.get(key) ?? [];
		bag.push(resource);
		byKey.set(key, bag);
	}
	const dup = [...byKey.values()].find((bag) => bag.length > 1);
	const replayed = world.replay();
	const live = world.fingerprint();
	const crossed = resources.find((resource) => {
		if (resource.status === "destroyed") return false;
		const bindle = bindles.get(resource.bindleId);
		return Boolean(bindle && bindle.tenantId !== resource.tenantId);
	});

	return [
		verdict(
			"retry-no-duplicate",
			dup === undefined,
			dup
				? `idempotency key ${dup[0]?.idempotencyKey} minted ${dup.length} resources`
				: "each idempotency key owns at most one live resource",
		),
		verdict(
			"replay-equals-state",
			replayed === live,
			replayed === live
				? "replay(history) == state"
				: `replay drifted: ${replayed} vs ${live}`,
		),
		verdict(
			"resource-tenant-owns-bindle",
			crossed === undefined,
			crossed
				? `resource ${crossed.id} on bindle ${crossed.bindleId} crossed tenants`
				: "live resources stay on a bindle owned by the same tenant",
		),
	];
}

export function tenantIsolationOk(
	beforeB: string,
	afterB: string,
): InvariantVerdict {
	return verdict(
		"tenant-isolation",
		beforeB === afterB,
		beforeB === afterB
			? "tenant B fingerprint unchanged"
			: `tenant B mutated: ${beforeB} -> ${afterB}`,
	);
}

export function attenuationOk(
	before: readonly Verb[],
	after: readonly Verb[],
): InvariantVerdict {
	const prior = new Set(before);
	const widened = after.some((verb) => !prior.has(verb));
	return verdict(
		"attenuate-never-widens",
		!widened,
		widened
			? `authority grew from ${before.join(",")} to ${after.join(",")}`
			: "attenuation did not add verbs",
	);
}
