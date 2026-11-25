/**
 * A decoder for the `pgoutput` logical-replication message format
 * (protocol version 1).
 *
 * Pure: bytes in, messages out. It opens no connection and reads no clock,
 * which is what lets it be tested offline against bytes recorded from a real
 * server. The capture port obtains the bytes through the server's SQL
 * decoding functions; this module neither knows nor cares how they arrived.
 *
 * Only what protocol version 1 can emit without streaming or two-phase
 * options is decoded. Anything else is refused by name rather than skipped:
 * a message this decoder does not understand may be a change it would lose.
 */
import { PostgresDataError } from "../errors.js";

function undecodable(message: string): never {
	throw new PostgresDataError("CAPTURE_STREAM_UNDECODABLE", message, {
		detail: { format: "pgoutput/1" },
	});
}

/** One column value inside a tuple. */
export type PgOutputCell =
	| { readonly kind: "null" }
	/** A large out-of-line value the statement did not change; not sent. */
	| { readonly kind: "unchanged" }
	| { readonly kind: "text"; readonly text: string };

/** A decoded row, by column name. */
export type PgOutputTuple = ReadonlyMap<string, PgOutputCell>;

export interface PgOutputColumn {
	readonly name: string;
	/** True when the column is part of the replica identity. */
	readonly key: boolean;
	readonly typeOid: number;
	readonly typeModifier: number;
}

export interface PgOutputRelation {
	readonly oid: number;
	readonly namespace: string;
	readonly name: string;
	/** `d` default, `n` nothing, `f` full, `i` index. */
	readonly replicaIdentity: string;
	readonly columns: readonly PgOutputColumn[];
}

/** Which old-row image a change carried: the key columns, or every column. */
export type PgOutputOldImage = "key" | "full";

export type PgOutputMessage =
	| {
			readonly kind: "begin";
			readonly finalLsn: bigint;
			readonly commitTimeMicros: bigint;
			readonly xid: number;
	  }
	| {
			readonly kind: "commit";
			readonly commitLsn: bigint;
			/** Where the commit record ends: the position of the transaction. */
			readonly endLsn: bigint;
			readonly commitTimeMicros: bigint;
	  }
	| { readonly kind: "origin"; readonly lsn: bigint; readonly name: string }
	| { readonly kind: "relation"; readonly relation: PgOutputRelation }
	| {
			readonly kind: "type";
			readonly oid: number;
			readonly namespace: string;
			readonly name: string;
	  }
	| {
			readonly kind: "insert";
			readonly relationOid: number;
			readonly row: readonly PgOutputCell[];
	  }
	| {
			readonly kind: "update";
			readonly relationOid: number;
			readonly oldImage?: PgOutputOldImage;
			readonly old?: readonly PgOutputCell[];
			readonly row: readonly PgOutputCell[];
	  }
	| {
			readonly kind: "delete";
			readonly relationOid: number;
			readonly oldImage: PgOutputOldImage;
			readonly old: readonly PgOutputCell[];
	  }
	| {
			readonly kind: "truncate";
			readonly relationOids: readonly number[];
			readonly cascade: boolean;
			readonly restartIdentity: boolean;
	  }
	| {
			readonly kind: "message";
			readonly transactional: boolean;
			readonly lsn: bigint;
			readonly prefix: string;
			readonly content: Uint8Array;
	  };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A bounds-checked big-endian reader over one message. */
class Reader {
	private offset = 0;
	private readonly view: DataView;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	private take(length: number): number {
		const start = this.offset;
		if (length < 0 || start + length > this.bytes.byteLength) {
			undecodable("message ends before its declared length");
		}
		this.offset = start + length;
		return start;
	}

	get done(): boolean {
		return this.offset === this.bytes.byteLength;
	}

	uint8(): number {
		return this.view.getUint8(this.take(1));
	}

	uint16(): number {
		return this.view.getUint16(this.take(2));
	}

	int32(): number {
		return this.view.getInt32(this.take(4));
	}

	uint32(): number {
		return this.view.getUint32(this.take(4));
	}

	uint64(): bigint {
		return this.view.getBigUint64(this.take(8));
	}

	int64(): bigint {
		return this.view.getBigInt64(this.take(8));
	}

	slice(length: number): Uint8Array {
		const start = this.take(length);
		return this.bytes.subarray(start, start + length);
	}

	text(length: number): string {
		try {
			return utf8.decode(this.slice(length));
		} catch {
			return undecodable("text is not valid UTF-8");
		}
	}

	/** A NUL-terminated string. */
	cstring(): string {
		const end = this.bytes.indexOf(0, this.offset);
		if (end < 0) undecodable("unterminated string");
		const value = this.text(end - this.offset);
		this.take(1);
		return value;
	}

	char(): string {
		return String.fromCharCode(this.uint8());
	}
}

function tuple(reader: Reader): readonly PgOutputCell[] {
	const count = reader.uint16();
	const cells: PgOutputCell[] = [];
	for (let index = 0; index < count; index += 1) {
		const kind = reader.char();
		if (kind === "n") {
			cells.push({ kind: "null" });
		} else if (kind === "u") {
			cells.push({ kind: "unchanged" });
		} else if (kind === "t") {
			cells.push({ kind: "text", text: reader.text(reader.int32()) });
		} else {
			// `b` is binary format, which this binding never requests.
			undecodable(`unsupported tuple column format ${kind}`);
		}
	}
	return cells;
}

function oldImage(marker: string): PgOutputOldImage {
	if (marker === "K") return "key";
	if (marker === "O") return "full";
	return undecodable(`unexpected old-tuple marker ${marker}`);
}

function relation(reader: Reader): PgOutputRelation {
	const oid = reader.uint32();
	const namespace = reader.cstring();
	const name = reader.cstring();
	const replicaIdentity = reader.char();
	const count = reader.uint16();
	const columns: PgOutputColumn[] = [];
	for (let index = 0; index < count; index += 1) {
		const flags = reader.uint8();
		columns.push({
			key: (flags & 1) === 1,
			name: reader.cstring(),
			typeOid: reader.uint32(),
			typeModifier: reader.int32(),
		});
	}
	return {
		oid,
		// An empty namespace on the wire means pg_catalog.
		namespace: namespace === "" ? "pg_catalog" : namespace,
		name,
		replicaIdentity,
		columns,
	};
}

function decodeBody(tag: string, reader: Reader): PgOutputMessage {
	switch (tag) {
		case "B":
			return {
				kind: "begin",
				finalLsn: reader.uint64(),
				commitTimeMicros: reader.int64(),
				xid: reader.uint32(),
			};
		case "C": {
			reader.uint8(); // flags, unused in protocol version 1
			return {
				kind: "commit",
				commitLsn: reader.uint64(),
				endLsn: reader.uint64(),
				commitTimeMicros: reader.int64(),
			};
		}
		case "O":
			return { kind: "origin", lsn: reader.uint64(), name: reader.cstring() };
		case "R":
			return { kind: "relation", relation: relation(reader) };
		case "Y":
			return {
				kind: "type",
				oid: reader.uint32(),
				namespace: reader.cstring(),
				name: reader.cstring(),
			};
		case "I": {
			const relationOid = reader.uint32();
			if (reader.char() !== "N") undecodable("insert carries no new tuple");
			return { kind: "insert", relationOid, row: tuple(reader) };
		}
		case "U": {
			const relationOid = reader.uint32();
			const marker = reader.char();
			if (marker === "N") {
				return { kind: "update", relationOid, row: tuple(reader) };
			}
			const image = oldImage(marker);
			const old = tuple(reader);
			if (reader.char() !== "N") undecodable("update carries no new tuple");
			return {
				kind: "update",
				relationOid,
				oldImage: image,
				old,
				row: tuple(reader),
			};
		}
		case "D": {
			const relationOid = reader.uint32();
			const image = oldImage(reader.char());
			return {
				kind: "delete",
				relationOid,
				oldImage: image,
				old: tuple(reader),
			};
		}
		case "T": {
			const count = reader.uint32();
			const options = reader.uint8();
			const relationOids: number[] = [];
			for (let index = 0; index < count; index += 1) {
				relationOids.push(reader.uint32());
			}
			return {
				kind: "truncate",
				relationOids,
				cascade: (options & 1) === 1,
				restartIdentity: (options & 2) === 2,
			};
		}
		case "M": {
			const flags = reader.uint8();
			const lsn = reader.uint64();
			const prefix = reader.cstring();
			return {
				kind: "message",
				transactional: (flags & 1) === 1,
				lsn,
				prefix,
				content: reader.slice(reader.uint32()),
			};
		}
		default:
			// Streaming (S, E, c, A) and two-phase (b, P, K, r, p) messages
			// need options this binding does not set.
			return undecodable(`unsupported message type ${tag}`);
	}
}

/** Decode one `pgoutput` message. Trailing bytes are an error, not ignored. */
export function decodePgOutputMessage(bytes: Uint8Array): PgOutputMessage {
	const reader = new Reader(bytes);
	const message = decodeBody(reader.char(), reader);
	if (!reader.done) undecodable("message has trailing bytes");
	return message;
}

// ── transactions ────────────────────────────────────────────────────────────

export type PgOutputRowChange =
	| {
			readonly op: "insert";
			readonly relation: PgOutputRelation;
			readonly row: PgOutputTuple;
	  }
	| {
			readonly op: "update";
			readonly relation: PgOutputRelation;
			readonly oldImage?: PgOutputOldImage;
			/** Present only when the key changed or the identity is full. */
			readonly old?: PgOutputTuple;
			readonly row: PgOutputTuple;
	  }
	| {
			readonly op: "delete";
			readonly relation: PgOutputRelation;
			readonly oldImage: PgOutputOldImage;
			readonly old: PgOutputTuple;
	  }
	| {
			readonly op: "truncate";
			readonly relations: readonly PgOutputRelation[];
	  };

export interface PgOutputTransaction {
	readonly xid: number;
	readonly commitLsn: bigint;
	/** Where the commit record ends; orders transactions and positions them. */
	readonly endLsn: bigint;
	readonly changes: readonly PgOutputRowChange[];
}

export interface PgOutputDecodeResult {
	readonly transactions: readonly PgOutputTransaction[];
	/** Every relation described so far, for a later call to start from. */
	readonly relations: ReadonlyMap<number, PgOutputRelation>;
}

function named(
	described: PgOutputRelation,
	cells: readonly PgOutputCell[],
): PgOutputTuple {
	if (cells.length !== described.columns.length) {
		undecodable(
			`tuple has ${cells.length} columns but ${described.name} was described with ${described.columns.length}`,
		);
	}
	const out = new Map<string, PgOutputCell>();
	described.columns.forEach((column, index) => {
		const cell = cells[index];
		if (cell !== undefined) out.set(column.name, cell);
	});
	return out;
}

/**
 * Group a message stream into whole transactions in commit order.
 *
 * A change is only meaningful against the relation description that preceded
 * it, so a change for a relation never described is an error. A stream that
 * ends inside a transaction is an error too: the server never emits a partial
 * transaction, so half of one means bytes went missing.
 */
export function decodePgOutputTransactions(
	messages: readonly Uint8Array[],
	knownRelations: ReadonlyMap<number, PgOutputRelation> = new Map(),
): PgOutputDecodeResult {
	const relations = new Map(knownRelations);
	const transactions: PgOutputTransaction[] = [];
	let open: { xid: number; changes: PgOutputRowChange[] } | undefined;

	const described = (oid: number): PgOutputRelation => {
		const found = relations.get(oid);
		return found ?? undecodable(`change for undescribed relation ${oid}`);
	};
	const inTransaction = (): PgOutputRowChange[] =>
		open === undefined
			? undecodable("change outside a transaction")
			: open.changes;

	for (const bytes of messages) {
		const message = decodePgOutputMessage(bytes);
		switch (message.kind) {
			case "begin":
				if (open !== undefined) undecodable("begin inside a transaction");
				open = { xid: message.xid, changes: [] };
				break;
			case "commit":
				if (open === undefined) undecodable("commit without a begin");
				transactions.push({
					xid: open.xid,
					commitLsn: message.commitLsn,
					endLsn: message.endLsn,
					changes: open.changes,
				});
				open = undefined;
				break;
			case "relation":
				relations.set(message.relation.oid, message.relation);
				break;
			case "insert": {
				const target = described(message.relationOid);
				inTransaction().push({
					op: "insert",
					relation: target,
					row: named(target, message.row),
				});
				break;
			}
			case "update": {
				const target = described(message.relationOid);
				inTransaction().push({
					op: "update",
					relation: target,
					row: named(target, message.row),
					...(message.old === undefined || message.oldImage === undefined
						? undefined
						: {
								oldImage: message.oldImage,
								old: named(target, message.old),
							}),
				});
				break;
			}
			case "delete": {
				const target = described(message.relationOid);
				inTransaction().push({
					op: "delete",
					relation: target,
					oldImage: message.oldImage,
					old: named(target, message.old),
				});
				break;
			}
			case "truncate":
				inTransaction().push({
					op: "truncate",
					relations: message.relationOids.map(described),
				});
				break;
			case "origin":
			case "type":
			case "message":
				// Carry no row change.
				break;
		}
	}
	if (open !== undefined) undecodable("stream ends inside a transaction");
	return { transactions, relations };
}
