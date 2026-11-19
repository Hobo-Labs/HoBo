import {
	create,
	fromJsonString,
	toJson,
	toJsonString,
} from "@bufbuild/protobuf";
import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import {
	PaginatedChangeDataSchema,
	PaginatedCursorDataSchema,
} from "./_generated/data_pb.js";
import { isOptimisticConflict } from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type Inspectable,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type PaginatedRow = JsonObject & {
	readonly id: string;
	readonly streamId: string;
	readonly seq: number;
};

export interface PaginatedPage {
	readonly items: readonly PaginatedRow[];
	readonly nextCursor: string | null;
	readonly seq: Readonly<Record<string, number>>;
}

export interface PaginatedViewOptions {
	readonly store: EventStore;
	readonly streamId: string;
	readonly resource: string;
	readonly tenant: string;
	readonly actor: PrincipalRef;
	readonly indexes: Readonly<Record<string, "string" | "number">>;
	readonly pollIntervalMs?: number;
}

export interface PaginatedSubscription {
	current(): PaginatedPage;
	loadMore(): Promise<PaginatedPage>;
	drain(): Promise<void>;
	unsubscribe(): void;
}

type SortKey = string | number;
type Position = { readonly key: SortKey; readonly id: string };
type IndexedRow = {
	readonly id: string;
	readonly streamId: string;
	readonly seq: number;
	readonly row: PaginatedRow | null;
	readonly keys: ReadonlyMap<string, SortKey>;
};

type WindowState = {
	readonly orderBy: string;
	readonly lower: Position | null;
	upper: Position | null;
	readonly pageSize: number;
	limit: number;
	current: PaginatedPage;
	readonly onPush: ((page: PaginatedPage) => void | Promise<void>) | undefined;
	readonly failures: Error[];
	delivery: Promise<void>;
	closed: boolean;
};

function validJson(value: Inspectable, parents: Set<object>): boolean {
	if (value === null || isJsonString(value) || isJsonBoolean(value))
		return true;
	if (isJsonNumber(value)) return Number.isFinite(value);
	if (!isJsonArray(value) && !isJsonObject(value)) return false;
	if (parents.has(value)) return false;
	parents.add(value);
	const result = (isJsonArray(value) ? value : Object.values(value)).every(
		(part) => validJson(part, parents),
	);
	parents.delete(value);
	return result;
}

function parseRow(
	value: JsonValue,
	indexes: PaginatedViewOptions["indexes"],
): PaginatedRow {
	if (!isJsonObject(value) || !validJson(value, new Set()))
		throw new TypeError("row must be a JSON object");
	if (!isJsonString(value.id) || !value.id.trim() || value.id.length > 512)
		throw new TypeError(
			"row.id must be a non-empty string of at most 512 characters",
		);
	if (!isJsonString(value.streamId) || !value.streamId.trim())
		throw new TypeError("row.streamId must be a non-empty string");
	if (
		!isJsonNumber(value.seq) ||
		!Number.isSafeInteger(value.seq) ||
		value.seq < 1
	)
		throw new TypeError("row.seq must be a positive safe integer");
	for (const [name, kind] of Object.entries(indexes)) {
		const key = value[name];
		if (kind === "string" && (!isJsonString(key) || key.length > 1024))
			throw new TypeError(
				`row.${name} must be an indexed string of at most 1024 characters`,
			);
		if (kind === "number" && (!isJsonNumber(key) || !Number.isFinite(key)))
			throw new TypeError(`row.${name} must be a finite indexed number`);
	}
	return { ...value, id: value.id, streamId: value.streamId, seq: value.seq };
}

function compare(left: SortKey, right: SortKey): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function comparePosition(left: Position, right: Position): number {
	return compare(left.key, right.key) || compare(left.id, right.id);
}

function position(row: IndexedRow, orderBy: string): Position {
	const key = row.keys.get(orderBy);
	if (key === undefined) throw new TypeError(`missing sort index: ${orderBy}`);
	return { key, id: row.id };
}

function pageLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
		throw new RangeError("limit must be a positive safe integer at most 10000");
}

export async function createPaginatedEventView(options: PaginatedViewOptions) {
	const { store, streamId, resource, tenant } = options;
	const actor = structuredClone(options.actor);
	for (const [name, value] of [
		["streamId", streamId],
		["resource", resource],
		["tenant", tenant],
	] as const) {
		if (!isJsonString(value) || !value.trim())
			throw new TypeError(`${name} must be a non-empty string`);
	}
	const indexes = Object.freeze({ ...options.indexes });
	const indexNames = Object.keys(indexes);
	if (
		indexNames.length === 0 ||
		indexNames.some(
			(name) =>
				!name.trim() ||
				(indexes[name] !== "string" && indexes[name] !== "number"),
		)
	)
		throw new TypeError("at least one typed sort index is required");
	const rows = new Map<string, IndexedRow>();
	const ordered = new Map<string, IndexedRow[]>();
	for (const name of indexNames) ordered.set(name, []);
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
		throw new RangeError("pollIntervalMs must be a positive safe integer");
	const windows = new Set<WindowState>();
	let backgroundFailure: Error | undefined;
	let revision = 0;
	let reading: Promise<void> | undefined;
	let notifications = Promise.resolve();
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	function assertOpen() {
		if (closed) throw new Error("paginated view is closed");
	}

	function scheduleRefresh(targetSeq?: number) {
		if (closed) return;
		notifications = notifications
			.then(async () => {
				if (closed) return;
				await refresh();
				if (targetSeq !== undefined && revision < targetSeq) await refresh();
			})
			.catch((error) => {
				backgroundFailure ??=
					error instanceof Error ? error : new Error(String(error));
			});
	}

	function startPolling() {
		if (timer) return;
		timer = setInterval(() => scheduleRefresh(), pollIntervalMs);
		timer.unref();
	}

	function stopPolling() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function updateIndex(previous: IndexedRow | undefined, next: IndexedRow) {
		for (const name of indexNames) {
			const index = ordered.get(name);
			if (!index) throw new TypeError(`unknown sort index: ${name}`);
			if (previous) {
				const old = index.findIndex((entry) => entry.id === previous.id);
				if (old >= 0) index.splice(old, 1);
			}
			const target = position(next, name);
			let lower = 0;
			let upper = index.length;
			while (lower < upper) {
				const middle = Math.floor((lower + upper) / 2);
				if (comparePosition(position(index[middle], name), target) < 0)
					lower = middle + 1;
				else upper = middle;
			}
			index.splice(lower, 0, next);
		}
		rows.set(next.id, next);
	}

	function apply(event: EventEnvelope): void {
		if (
			event.seq !== revision + 1 ||
			event.tenant !== tenant ||
			event.type !== "data.Changed"
		)
			throw new TypeError(`invalid paginated event at sequence ${event.seq}`);
		const change = fromJsonString(
			PaginatedChangeDataSchema,
			JSON.stringify(event.data),
		);
		if (
			change.resource !== resource ||
			!change.key ||
			!change.sourceStreamId ||
			!Number.isSafeInteger(change.sourceSeq) ||
			change.sourceSeq < 1 ||
			!["insert", "update", "delete"].includes(change.op)
		)
			throw new TypeError(`invalid paginated change at sequence ${event.seq}`);
		const previous = rows.get(change.key);
		if (
			previous &&
			(previous.streamId !== change.sourceStreamId ||
				change.sourceSeq <= previous.seq)
		)
			throw new TypeError(`source sequence must advance for ${change.key}`);
		let next: IndexedRow;
		if (change.op === "delete") {
			if (!previous || !previous.row || change.rowJson)
				throw new TypeError(`cannot delete unknown row: ${change.key}`);
			next = { ...previous, seq: change.sourceSeq, row: null };
		} else {
			const value: JsonValue = JSON.parse(change.rowJson);
			const row = parseRow(value, indexes);
			if (
				row.id !== change.key ||
				row.streamId !== change.sourceStreamId ||
				row.seq !== change.sourceSeq ||
				(change.op === "insert") !== (!previous || !previous.row)
			)
				throw new TypeError(
					`paginated change does not match row ${change.key}`,
				);
			const keys = new Map<string, SortKey>();
			for (const name of indexNames) {
				const key = row[name];
				if (!isJsonString(key) && !isJsonNumber(key))
					throw new TypeError(`invalid indexed key ${name}`);
				keys.set(name, key);
			}
			next = { id: row.id, streamId: row.streamId, seq: row.seq, row, keys };
		}
		updateIndex(previous, next);
		revision = event.seq;
		notifyWindows(previous, next);
	}

	function refresh(): Promise<void> {
		assertOpen();
		if (reading) return reading;
		const pending = (async () => {
			for await (const event of store.read(streamId, revision + 1))
				apply(event);
		})();
		reading = pending;
		pending.then(
			() => {
				if (reading === pending) reading = undefined;
			},
			() => {
				if (reading === pending) reading = undefined;
			},
		);
		return pending;
	}

	function cursorFor(orderBy: string, boundary: Position): string {
		return Buffer.from(
			toJsonString(
				PaginatedCursorDataSchema,
				create(PaginatedCursorDataSchema, {
					resource: resource,
					orderBy,
					keyJson: JSON.stringify(boundary.key),
					rowId: boundary.id,
					streamId: streamId,
					tenant: tenant,
				}),
			),
			"utf8",
		).toString("base64url");
	}

	function parseCursor(
		orderBy: string,
		cursor: string | null | undefined,
	): Position | null {
		if (cursor === null || cursor === undefined) return null;
		if (!isJsonString(cursor) || !cursor || cursor.length > 4096)
			throw new TypeError("invalid cursor");
		const bytes = Buffer.from(cursor, "base64url");
		if (bytes.toString("base64url") !== cursor)
			throw new TypeError("invalid cursor encoding");
		const value = fromJsonString(
			PaginatedCursorDataSchema,
			bytes.toString("utf8"),
		);
		if (
			value.resource !== resource ||
			value.streamId !== streamId ||
			value.tenant !== tenant ||
			value.orderBy !== orderBy ||
			!value.rowId ||
			!value.keyJson
		)
			throw new TypeError("cursor does not match this view and sort order");
		const key: JsonValue = JSON.parse(value.keyJson);
		if (
			(indexes[orderBy] === "string" &&
				(!isJsonString(key) || key.length > 1024)) ||
			(indexes[orderBy] === "number" &&
				(!isJsonNumber(key) || !Number.isFinite(key))) ||
			(!isJsonString(key) && !isJsonNumber(key))
		)
			throw new TypeError("cursor has an invalid sort key");
		return { key, id: value.rowId };
	}

	function page(
		orderBy: string,
		lower: Position | null,
		upper: Position | null,
		limit: number,
	): PaginatedPage {
		const index = ordered.get(orderBy);
		if (!index) throw new TypeError(`sort key is not indexable: ${orderBy}`);
		const within = index.filter(
			(entry) =>
				(!lower || comparePosition(position(entry, orderBy), lower) > 0) &&
				(!upper || comparePosition(position(entry, orderBy), upper) <= 0),
		);
		const live = within.filter((entry) => entry.row !== null).slice(0, limit);
		const last = live.at(-1);
		const boundary = upper ?? (last ? position(last, orderBy) : null);
		const seq = new Map<string, number>();
		for (const entry of within) {
			if (entry.row !== null && !live.includes(entry)) continue;
			if (boundary && comparePosition(position(entry, orderBy), boundary) > 0)
				continue;
			seq.set(
				entry.streamId,
				Math.max(seq.get(entry.streamId) ?? 0, entry.seq),
			);
		}
		return Object.freeze({
			items: Object.freeze(live.map((entry) => structuredClone(entry.row))),
			nextCursor: last ? cursorFor(orderBy, position(last, orderBy)) : null,
			seq: Object.freeze(Object.fromEntries(seq)),
		});
	}

	function copyPage(value: PaginatedPage): PaginatedPage {
		return structuredClone(value);
	}

	function push(window: WindowState): void {
		if (!window.onPush || window.closed) return;
		const value = copyPage(window.current);
		const onPush = window.onPush;
		window.delivery = window.delivery
			.then(async () => {
				if (!window.closed) await onPush(value);
			})
			.catch((error) => {
				window.failures.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
	}

	function windowPage(
		window: WindowState,
		changed?: IndexedRow,
	): PaginatedPage {
		const result = page(
			window.orderBy,
			window.lower,
			window.upper,
			window.limit,
		);
		const seq = new Map(Object.entries(window.current.seq));
		for (const [source, value] of Object.entries(result.seq))
			seq.set(source, Math.max(seq.get(source) ?? 0, value));
		if (changed)
			seq.set(
				changed.streamId,
				Math.max(seq.get(changed.streamId) ?? 0, changed.seq),
			);
		return Object.freeze({
			items: result.items,
			nextCursor: window.upper ? cursorFor(window.orderBy, window.upper) : null,
			seq: Object.freeze(Object.fromEntries(seq)),
		});
	}

	function touchesWindow(
		window: WindowState,
		row: IndexedRow | undefined,
	): boolean {
		if (!row) return false;
		const point = position(row, window.orderBy);
		return (
			(!window.lower || comparePosition(point, window.lower) > 0) &&
			(!window.upper || comparePosition(point, window.upper) <= 0)
		);
	}

	function notifyWindows(previous: IndexedRow | undefined, next: IndexedRow) {
		for (const window of windows) {
			if (
				window.closed ||
				(!touchesWindow(window, previous) && !touchesWindow(window, next))
			)
				continue;
			if (!window.upper) {
				const initial = page(
					window.orderBy,
					window.lower,
					null,
					window.pageSize,
				);
				const last = initial.items.at(-1);
				if (last) {
					const indexed = rows.get(last.id);
					if (!indexed) throw new Error("indexed row disappeared");
					window.upper = position(indexed, window.orderBy);
				}
			}
			const updated = windowPage(window, next);
			if (JSON.stringify(updated) !== JSON.stringify(window.current)) {
				window.current = updated;
				push(window);
			}
		}
	}

	async function watch(
		orderBy: string,
		input: {
			cursor?: string | null;
			limit: number;
			onPush?: (page: PaginatedPage) => void | Promise<void>;
		},
	): Promise<PaginatedSubscription> {
		assertOpen();
		pageLimit(input.limit);
		if (input.onPush !== undefined && !(input.onPush instanceof Function))
			throw new TypeError("onPush must be a function");
		const lower = parseCursor(orderBy, input.cursor);
		await refresh();
		assertOpen();
		const initial = page(orderBy, lower, null, input.limit);
		const last = initial.items.at(-1);
		const indexed = last ? rows.get(last.id) : undefined;
		if (last && !indexed) throw new Error("indexed row disappeared");
		const window: WindowState = {
			orderBy,
			lower,
			upper: indexed ? position(indexed, orderBy) : null,
			pageSize: input.limit,
			limit: input.limit,
			current: initial,
			onPush: input.onPush,
			failures: [],
			delivery: Promise.resolve(),
			closed: false,
		};
		windows.add(window);
		startPolling();
		push(window);
		return {
			current() {
				return copyPage(window.current);
			},
			async loadMore() {
				assertOpen();
				if (window.closed) throw new Error("paginated subscription is closed");
				await refresh();
				assertOpen();
				if (window.closed) throw new Error("paginated subscription is closed");
				const next = page(
					orderBy,
					window.upper ?? window.lower,
					null,
					window.pageSize,
				);
				const last = next.items.at(-1);
				if (!last) return copyPage(window.current);
				const indexed = rows.get(last.id);
				if (!indexed) throw new Error("indexed row disappeared");
				if (window.upper) {
					const index = ordered.get(orderBy);
					if (!index)
						throw new TypeError(`sort key is not indexable: ${orderBy}`);
					const active = index.filter(
						(entry) => entry.row !== null && touchesWindow(window, entry),
					).length;
					const expanded = Math.max(window.limit, active) + next.items.length;
					if (expanded > 10_000)
						throw new RangeError("expanded window exceeds 10000 rows");
					window.limit = expanded;
				}
				window.upper = position(indexed, orderBy);
				window.current = windowPage(window);
				push(window);
				return copyPage(window.current);
			},
			async drain() {
				let pending: Promise<void>;
				do {
					pending = notifications;
					await pending;
				} while (pending !== notifications);
				if (!closed) await refresh();
				let delivery: Promise<void>;
				do {
					delivery = window.delivery;
					await delivery;
				} while (delivery !== window.delivery);
				const errors = window.failures.splice(0);
				if (backgroundFailure) errors.unshift(backgroundFailure);
				backgroundFailure = undefined;
				if (errors.length)
					throw new AggregateError(errors, "paginated subscription failed");
			},
			unsubscribe() {
				window.closed = true;
				windows.delete(window);
				if (windows.size === 0) stopPolling();
			},
		};
	}

	async function append(
		row: PaginatedRow | null,
		id: string,
		sourceSeq: number,
	): Promise<void> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			await refresh();
			const previous = rows.get(id);
			if (!row && (!previous || !previous.row))
				throw new TypeError(`cannot delete unknown row: ${id}`);
			const sourceStreamId = row?.streamId ?? previous?.streamId;
			if (
				!sourceStreamId ||
				(previous &&
					(previous.streamId !== sourceStreamId || sourceSeq <= previous.seq))
			)
				throw new TypeError(`source sequence must advance for ${id}`);
			const op = row ? (previous?.row ? "update" : "insert") : "delete";
			const data = create(PaginatedChangeDataSchema, {
				resource: resource,
				key: id,
				op,
				sourceSeq,
				sourceStreamId,
				rowJson: row ? JSON.stringify(row) : "",
			});
			try {
				const result = await store.append(
					streamId,
					[
						{
							type: "data.Changed",
							data: toJson(PaginatedChangeDataSchema, data),
						},
					],
					{
						expectedSeq: revision,
						tenant: tenant,
						actor: actor,
					},
				);
				const lastSeq = result.appended.at(-1)?.seq;
				if (lastSeq === undefined)
					throw new Error("paginated change was not appended");
				while (revision < lastSeq) await refresh();
				return;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!isOptimisticConflict(error) ||
					attempt === 7
				)
					throw error;
			}
		}
	}

	const subscription = store.subscribe(
		{ streamId, type: "data.Changed" },
		(event) => {
			if (event.tenant === tenant) scheduleRefresh(event.seq);
		},
	);
	try {
		await subscription.ready;
		await refresh();
	} catch (error) {
		subscription.unsubscribe();
		throw error;
	}
	return {
		refresh,
		close() {
			closed = true;
			subscription.unsubscribe();
			stopPolling();
			for (const window of windows) window.closed = true;
			windows.clear();
		},
		async upsert(input: JsonObject) {
			assertOpen();
			if (!validJson(input, new Set())) throw new TypeError("row must be JSON");
			const value: JsonValue = JSON.parse(JSON.stringify(input));
			const row = parseRow(value, indexes);
			await append(row, row.id, row.seq);
		},
		async delete(id: string, seq: number) {
			assertOpen();
			if (
				!isJsonString(id) ||
				!id.trim() ||
				!Number.isSafeInteger(seq) ||
				seq < 1
			)
				throw new TypeError("delete requires an id and positive sequence");
			await append(null, id, seq);
		},
		order(orderBy: string) {
			assertOpen();
			if (!ordered.has(orderBy))
				throw new TypeError(`sort key is not indexable: ${orderBy}`);
			return {
				async paginate(input: { cursor?: string | null; limit: number }) {
					pageLimit(input.limit);
					const lower = parseCursor(orderBy, input.cursor);
					await refresh();
					return page(orderBy, lower, null, input.limit);
				},
				watch(input: {
					cursor?: string | null;
					limit: number;
					onPush?: (page: PaginatedPage) => void | Promise<void>;
				}) {
					return watch(orderBy, input);
				},
			};
		},
	};
}
