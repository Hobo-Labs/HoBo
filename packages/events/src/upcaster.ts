/**
 * Golden-replay corpus + upcaster-totality gate (ADR-0032 / data-plane
 * Plan 9-11). Canonical home of the promoted `event-body-upcaster-gate`
 * draft proof.
 *
 * The corpus pins one real encoded body per (event type, version) ever
 * shipped, append-only. CI replays every entry through the current upcaster
 * chain; a body that cannot be lifted to the current version fails the gate —
 * and with it `can-deploy`. Adding a version bump without extending the
 * corpus is itself a gate failure (coverage check).
 */
import { createHash } from "node:crypto";

// public-contract: gate report schema id.
export const EVENT_BODY_UPCASTER_GATE_SCHEMA =
	"hobo.event-body-upcaster-gate/v1";
// public-contract: corpus entry schema id.
export const CORPUS_ENTRY_SCHEMA = "hobo.golden-replay-corpus-entry/v1";
// public-contract: corpus baseline schema id.
export const CORPUS_BASELINE_SCHEMA = "hobo.golden-replay-corpus-baseline/v1";

export type EventFieldType = "string" | "u32";

export interface EventFieldSpec {
	readonly name: string;
	readonly tag: number;
	readonly type: EventFieldType;
	readonly required: boolean;
}

export interface EventBodySchema {
	readonly type: string;
	readonly version: number;
	readonly fields: readonly EventFieldSpec[];
}

export type EventBodyValue = string | number | undefined;
export type EventBody = Readonly<Record<string, EventBodyValue>>;

export interface EventBodyUpcaster {
	readonly type: string;
	readonly from: number;
	readonly to: number;
	/** Why the semantic change needs an upcaster (review evidence). */
	readonly reason: string;
	readonly upcast: (body: EventBody) => EventBody;
}

type EventBodyInput =
	| EventBody
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined;
type ThrownValue = EventBodyInput;
type CanonicalValue =
	| EventBodyValue
	| boolean
	| null
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue };

export interface CorpusEntry {
	readonly schema: typeof CORPUS_ENTRY_SCHEMA;
	readonly id: string;
	readonly type: string;
	readonly version: number;
	readonly encoding: "protobuf-lite";
	readonly bodyBase64: string;
	readonly bodyDigest: string;
}

export interface EventEvolutionContract {
	readonly type: string;
	readonly currentVersion: number;
	readonly schemas: readonly EventBodySchema[];
	readonly upcasters: readonly EventBodyUpcaster[];
	readonly goldenCorpus: readonly CorpusEntry[];
}

export interface CorpusBaseline {
	readonly schema: typeof CORPUS_BASELINE_SCHEMA;
	readonly entries: readonly {
		readonly key: string;
		readonly bodyDigest: string;
	}[];
}

export interface CorpusReplay {
	readonly key: string;
	readonly sourceVersion: number;
	readonly currentVersion: number;
	readonly currentBody: EventBody;
	readonly currentDigest: string;
}

export interface UpcasterGateReport {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly replays: readonly CorpusReplay[];
}

export function eventSchema(
	type: string,
	version: number,
	fields: readonly EventFieldSpec[],
): EventBodySchema {
	return Object.freeze({ type, version, fields: Object.freeze([...fields]) });
}

export function stringField(
	name: string,
	tag: number,
	options: { readonly required?: boolean } = {},
): EventFieldSpec {
	return Object.freeze({
		name,
		tag,
		type: "string" as const,
		required: options.required !== false,
	});
}

export function u32Field(
	name: string,
	tag: number,
	options: { readonly required?: boolean } = {},
): EventFieldSpec {
	return Object.freeze({
		name,
		tag,
		type: "u32" as const,
		required: options.required !== false,
	});
}

/** Encode + pin a real body as an append-only corpus entry. */
export function createCorpusEntry(
	schema: EventBodySchema,
	id: string,
	body: EventBody,
): CorpusEntry {
	const bytes = encodeEventBody(schema, body);
	return Object.freeze({
		schema: CORPUS_ENTRY_SCHEMA,
		id,
		type: schema.type,
		version: schema.version,
		encoding: "protobuf-lite" as const,
		bodyBase64: bytes.toString("base64"),
		bodyDigest: sha256(bytes),
	});
}

export function createCorpusBaseline(
	goldenCorpus: readonly CorpusEntry[],
): CorpusBaseline {
	return Object.freeze({
		schema: CORPUS_BASELINE_SCHEMA,
		entries: Object.freeze(
			goldenCorpus.map((entry) =>
				Object.freeze({ key: corpusKey(entry), bodyDigest: entry.bodyDigest }),
			),
		),
	});
}

/**
 * The can-deploy gate: corpus coverage per shipped version, append-only
 * baseline, total upcaster chain, upcaster purity, and full golden replay.
 */
export function runCanDeployUpcasterGate(
	contract: EventEvolutionContract,
	options: { readonly baselineCorpus?: CorpusBaseline } = {},
): UpcasterGateReport {
	const errors: string[] = [];
	const replays: CorpusReplay[] = [];
	const schemas = [...contract.schemas].sort(
		(left, right) => left.version - right.version,
	);
	const schemasByVersion = new Map(
		schemas.map((schema) => [schema.version, schema]),
	);
	const upcastersByFrom = new Map(
		contract.upcasters.map((upcaster) => [upcaster.from, upcaster]),
	);
	const corpus = contract.goldenCorpus ?? [];

	// Coverage: every shipped version has a pinned body.
	for (const schema of schemas) {
		const hasEntry = corpus.some(
			(entry) =>
				entry.type === contract.type && entry.version === schema.version,
		);
		if (!hasEntry) {
			errors.push(
				`missing golden corpus entry for ${contract.type}@v${schema.version}`,
			);
		}
	}

	// Append-only: baseline entries may never vanish or change digest.
	if (options.baselineCorpus) {
		const current = new Map(
			corpus.map((entry) => [corpusKey(entry), entry.bodyDigest]),
		);
		for (const baselineEntry of options.baselineCorpus.entries) {
			const currentDigest = current.get(baselineEntry.key);
			if (!currentDigest) {
				errors.push(
					`append-only corpus deletion detected: ${baselineEntry.key}`,
				);
				continue;
			}
			if (currentDigest !== baselineEntry.bodyDigest) {
				errors.push(
					`append-only corpus digest changed for ${baselineEntry.key}`,
				);
			}
		}
	}

	// Totality: every version below current has exactly the next-step upcaster.
	for (const schema of schemas) {
		if (schema.version >= contract.currentVersion) continue;
		const expectedTo = schema.version + 1;
		const upcaster = upcastersByFrom.get(schema.version);
		if (!upcaster || upcaster.to !== expectedTo) {
			errors.push(
				`non-total upcaster chain for ${contract.type}@v${schema.version}: missing ${schema.version}->${expectedTo}`,
			);
		}
	}

	// Purity: same input twice → same output; output validates against target.
	for (const upcaster of upcastersByFrom.values()) {
		const sourceSchema = schemasByVersion.get(upcaster.from);
		const targetSchema = schemasByVersion.get(upcaster.to);
		const sourceEntry = corpus.find(
			(entry) =>
				entry.type === contract.type && entry.version === upcaster.from,
		);
		if (!sourceSchema || !targetSchema || !sourceEntry) continue;

		let sourceBody: EventBody;
		try {
			sourceBody = decodeCorpusEntry(sourceSchema, sourceEntry);
		} catch (error) {
			errors.push(
				`${contract.type}@v${upcaster.from} corpus decode failed: ${message(error)}`,
			);
			continue;
		}
		let first: EventBody;
		let second: EventBody;
		try {
			first = upcaster.upcast(deepFreeze(deepClone(sourceBody)));
			second = upcaster.upcast(deepFreeze(deepClone(sourceBody)));
		} catch (error) {
			errors.push(
				`${contract.type}@v${upcaster.from} upcaster ${upcaster.from}->${upcaster.to} purity check threw: ${message(error)}`,
			);
			continue;
		}
		if (canonicalJson(first) !== canonicalJson(second)) {
			errors.push(
				`impure upcaster for ${contract.type}@v${upcaster.from}: identical input produced different output`,
			);
		}
		const validation = validateEventBody(targetSchema, first);
		if (!validation.ok) {
			errors.push(
				`${contract.type}@v${upcaster.from} upcaster ${upcaster.from}->${upcaster.to} produced invalid v${upcaster.to} body: ${validation.errors.join("; ")}`,
			);
		}
	}

	// Golden replay: every pinned body must lift to the current version.
	for (const entry of corpus) {
		try {
			replays.push(
				replayCorpusEntry({
					contract,
					schemasByVersion,
					upcastersByFrom,
					entry,
				}),
			);
		} catch (error) {
			errors.push(
				`${entry.type}@v${entry.version}#${entry.id} replay failed: ${message(error)}`,
			);
		}
	}

	return Object.freeze({
		ok: errors.length === 0,
		errors: Object.freeze(errors),
		replays: Object.freeze(replays),
	});
}

function replayCorpusEntry(input: {
	contract: EventEvolutionContract;
	schemasByVersion: ReadonlyMap<number, EventBodySchema>;
	upcastersByFrom: ReadonlyMap<number, EventBodyUpcaster>;
	entry: CorpusEntry;
}): CorpusReplay {
	const { contract, schemasByVersion, upcastersByFrom, entry } = input;
	let schema = schemasByVersion.get(entry.version);
	if (!schema) {
		throw new Error(`no schema registered for v${entry.version}`);
	}
	let body = decodeCorpusEntry(schema, entry);
	let version = entry.version;

	while (version < contract.currentVersion) {
		const upcaster = upcastersByFrom.get(version);
		if (!upcaster || upcaster.to !== version + 1) {
			throw new Error(
				`non-total upcaster chain for ${entry.type}@v${version}: missing ${version}->${version + 1}`,
			);
		}
		body = upcaster.upcast(deepFreeze(deepClone(body)));
		version = upcaster.to;
		const next = schemasByVersion.get(version);
		if (!next) throw new Error(`no schema registered for v${version}`);
		schema = next;
		const validation = validateEventBody(schema, body);
		if (!validation.ok) {
			throw new Error(
				`upcaster ${upcaster.from}->${upcaster.to} produced invalid v${version} body: ${validation.errors.join("; ")}`,
			);
		}
	}

	const currentSchema = schemasByVersion.get(contract.currentVersion);
	if (!currentSchema) {
		throw new Error(`no schema registered for v${contract.currentVersion}`);
	}
	const currentWire = encodeEventBody(currentSchema, body);
	return Object.freeze({
		key: corpusKey(entry),
		sourceVersion: entry.version,
		currentVersion: contract.currentVersion,
		currentBody: body,
		currentDigest: sha256(currentWire),
	});
}

function decodeCorpusEntry(
	schema: EventBodySchema,
	entry: CorpusEntry,
): EventBody {
	if (entry.encoding !== "protobuf-lite") {
		throw new Error(`unsupported corpus encoding ${String(entry.encoding)}`);
	}
	const bytes = Buffer.from(entry.bodyBase64, "base64");
	const digest = sha256(bytes);
	if (digest !== entry.bodyDigest) {
		throw new Error(`digest mismatch for ${corpusKey(entry)}`);
	}
	const body = decodeEventBody(schema, bytes);
	const validation = validateEventBody(schema, body);
	if (!validation.ok) {
		throw new Error(validation.errors.join("; "));
	}
	return body;
}

export function validateEventBody(
	schema: EventBodySchema,
	body: EventBodyInput,
) {
	const errors: string[] = [];
	if (!body || Object(body) !== body || Array.isArray(body)) {
		return { ok: false, errors: ["event body must be an object"] };
	}
	// SAFETY: the preceding guard excludes null, primitives, and arrays.
	const record = body as EventBody;
	const declared = new Set(schema.fields.map((field) => field.name));
	for (const field of schema.fields) {
		const value = record[field.name];
		if (value === undefined && field.required === false) continue;
		if (field.type === "string" && value?.constructor !== String) {
			errors.push(`${field.name} must be a string`);
			continue;
		}
		if (
			field.type === "u32" &&
			// SAFETY: Number.isInteger proves this schema-declared value is numeric.
			(!Number.isInteger(value) || Number(value) < 0)
		) {
			errors.push(`${field.name} must be a non-negative integer`);
		}
	}
	for (const key of Object.keys(record)) {
		if (!declared.has(key)) {
			errors.push(
				`${key} is not declared in ${schema.type}@v${schema.version}`,
			);
		}
	}
	return { ok: errors.length === 0, errors };
}

export function encodeEventBody(
	schema: EventBodySchema,
	body: EventBody,
): Buffer {
	const validation = validateEventBody(schema, body);
	if (!validation.ok) {
		throw new Error(validation.errors.join("; "));
	}
	const chunks: Buffer[] = [];
	for (const field of [...schema.fields].sort(
		(left, right) => left.tag - right.tag,
	)) {
		const value = body[field.name];
		if (value === undefined) continue;
		if (field.type === "string") {
			// SAFETY: schema validation immediately above accepts only string values here.
			const bytes = Buffer.from(value as string, "utf8");
			chunks.push(
				encodeVarint((field.tag << 3) | 2),
				encodeVarint(bytes.length),
				bytes,
			);
			continue;
		}
		// SAFETY: schema validation immediately above accepts only u32 values here.
		chunks.push(encodeVarint(field.tag << 3), encodeVarint(value as number));
	}
	return Buffer.concat(chunks);
}

export function decodeEventBody(schema: EventBodySchema, bytes: Buffer) {
	const fieldsByTag = new Map(schema.fields.map((field) => [field.tag, field]));
	const decoded: Record<string, EventBodyValue> = {};
	let offset = 0;
	while (offset < bytes.length) {
		const key = readVarint(bytes, offset);
		offset = key.offset;
		const tag = key.value >> 3;
		const wireType = key.value & 7;
		const field = fieldsByTag.get(tag);
		if (!field) {
			throw new Error(`unknown protobuf field tag ${tag}`);
		}
		if (wireType === 2 && field.type === "string") {
			const length = readVarint(bytes, offset);
			offset = length.offset;
			decoded[field.name] = Buffer.from(
				bytes.subarray(offset, offset + length.value),
			).toString("utf8");
			offset += length.value;
			continue;
		}
		if (wireType === 0 && field.type === "u32") {
			const value = readVarint(bytes, offset);
			offset = value.offset;
			decoded[field.name] = value.value;
			continue;
		}
		throw new Error(
			`protobuf wire type ${wireType} does not match ${field.name}`,
		);
	}
	return decoded;
}

function encodeVarint(value: number): Buffer {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(
			`protobuf varint must be a non-negative integer: ${String(value)}`,
		);
	}
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = remaining & 0x7f;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) byte |= 0x80;
		bytes.push(byte);
	} while (remaining > 0);
	return Buffer.from(bytes);
}

function readVarint(bytes: Buffer, startOffset: number) {
	let value = 0;
	let shift = 0;
	for (let offset = startOffset; offset < bytes.length; offset += 1) {
		// SAFETY: the loop bound guarantees a byte exists at this offset.
		const byte = bytes[offset] as number;
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			return { value, offset: offset + 1 };
		}
		shift += 7;
	}
	throw new Error("unterminated protobuf varint");
}

function corpusKey(entry: CorpusEntry): string {
	return `${entry.type}@v${entry.version}#${entry.id}`;
}

function sha256(value: Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function message(error: ThrownValue): string {
	return error instanceof Error ? error.message : String(error);
}

function deepClone<T>(value: T): T {
	// SAFETY: JSON round-tripping preserves the caller's cloneable T shape.
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (!value || Object(value) !== value) return value;
	Object.freeze(value);
	for (const child of Object.values(Object(value))) {
		deepFreeze(child);
	}
	return value;
}

function canonicalJson(value: CanonicalValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value && Object(value) === value) {
		// SAFETY: the object branch guarantees an object suitable for keyed traversal.
		const record = value as { readonly [key: string]: CanonicalValue };
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
