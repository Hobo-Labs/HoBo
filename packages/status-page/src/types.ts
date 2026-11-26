/**
 * Status-page domain model (ADR-0077 / Plan 49 §C).
 *
 * Parse-don't-validate: every record on a status page is built through a
 * parse function that throws `StatusPageParseError` on malformed input and
 * returns a frozen value. Wire forms live in `data-models/status_page.proto`;
 * CUE constraints in `data-models/status_page.cue`.
 *
 * The freshness rule is load-bearing: a component whose last signal is older
 * than the freshness budget renders as `unknown` ("status delayed / unknown"),
 * never as a stale `operational` (ADR-0077 §4).
 */

// public-contract: schema tag on every status-page snapshot/model record.
export const STATUS_PAGE_SCHEMA = "hobo.status-page/v1" as const;

// public-contract: closed component status vocabulary (worst-of ordering below).
export const COMPONENT_STATUSES = [
	"operational",
	"maintenance",
	"unknown",
	"degraded",
	"partial_outage",
	"major_outage",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

/** Severity rank for worst-of rollups. `unknown` outranks `operational`. */
const COMPONENT_STATUS_RANK = {
	operational: 0,
	maintenance: 1,
	unknown: 2,
	degraded: 3,
	partial_outage: 4,
	major_outage: 5,
};

export function worstComponentStatus(
	statuses: readonly ComponentStatus[],
): ComponentStatus {
	let worst: ComponentStatus = "operational";
	for (const status of statuses) {
		if (COMPONENT_STATUS_RANK[status] > COMPONENT_STATUS_RANK[worst]) {
			worst = status;
		}
	}
	return worst;
}

// public-contract: customer-safe incident lifecycle (HOBO-497 vocabulary).
export const INCIDENT_STATES = [
	"investigating",
	"identified",
	"monitoring",
	"resolved",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

/** Forward-only lifecycle rank; late/out-of-order events must never regress. */
export const INCIDENT_STATE_RANK = {
	investigating: 0,
	identified: 1,
	monitoring: 2,
	resolved: 3,
};

// public-contract: incident impact vocabulary (statuspage-v2 compatible).
export const INCIDENT_IMPACTS = ["minor", "major", "critical"] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

// public-contract: maintenance lifecycle (HOBO-497 vocabulary).
export const MAINTENANCE_STATES = [
	"scheduled",
	"in-progress",
	"completed",
	"canceled",
] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

const MAINTENANCE_STATE_RANK = {
	scheduled: 0,
	"in-progress": 1,
	completed: 2,
	canceled: 2,
};

// public-contract: the availability slices a page can project.
export const STATUS_SCOPE_KINDS = [
	"station",
	"primitives",
	"project",
	"bindle",
] as const;
export type StatusScopeKind = (typeof STATUS_SCOPE_KINDS)[number];

// public-contract: overall page indicator (statuspage-v2 + `unknown`).
export const OVERALL_INDICATORS = [
	"none",
	"minor",
	"major",
	"critical",
	"maintenance",
	"unknown",
] as const;
export type OverallIndicator = (typeof OVERALL_INDICATORS)[number];

export const COMPONENT_KINDS = [
	"capability",
	"primitive",
	"app-kit",
	"dependency",
	"bindle",
	"sidecar",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export class StatusPageParseError extends TypeError {
	readonly path: string;
	constructor(path: string, message: string) {
		super(`[status-page-parse] ${path}: ${message}`);
		this.name = "StatusPageParseError";
		this.path = path;
	}
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const INCIDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface StatusScope {
	readonly kind: StatusScopeKind;
	readonly id: string;
	readonly label: string;
}

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface ComponentSpec {
	readonly id: string;
	readonly label: string;
	readonly kind: ComponentKind;
	readonly description?: string;
}

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface IncidentUpdateRecord {
	readonly state: IncidentState;
	readonly body: string;
	readonly at: string;
	readonly public: boolean;
}

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface IncidentRecord {
	readonly id: string;
	readonly title: string;
	readonly state: IncidentState;
	readonly impact: IncidentImpact;
	readonly affectedComponents: readonly string[];
	readonly openedAt: string;
	readonly updatedAt: string;
	readonly resolvedAt?: string;
	readonly updates: readonly IncidentUpdateRecord[];
}

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface MaintenanceRecord {
	readonly id: string;
	readonly title: string;
	readonly state: MaintenanceState;
	readonly windowStart: string;
	readonly windowEnd: string;
	readonly affectedComponents: readonly string[];
	readonly expectedImpact: string;
}

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ParsedComponent = {
	id: string;
	label: string;
	kind: ComponentKind;
	description?: string;
};
type ParsedIncident = {
	id: string;
	title: string;
	state: IncidentState;
	impact: IncidentImpact;
	affectedComponents: readonly string[];
	openedAt: string;
	updatedAt: string;
	resolvedAt?: string;
	updates: readonly IncidentUpdateRecord[];
};

/** One UTC day of observed history for a component (uptime bar cell). */
// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface DailyStatusRecord {
	readonly date: string;
	readonly worst: ComponentStatus;
	readonly samples: number;
}

// domain-view: parse-don't-validate parsed/derived type (frozen, enum-narrowed, regex-constrained fields); its wire form is data-models/status_page.proto (technical-standards.md, IMPL-011).
export interface ComponentStatusRecord {
	readonly spec: ComponentSpec;
	readonly status: ComponentStatus;
	readonly lastSignalAt?: string;
	readonly attainment?: number;
	readonly target?: number;
	readonly history: readonly DailyStatusRecord[];
	/** True when the freshness budget forced this component to `unknown`. */
	readonly delayed: boolean;
}

export interface StatusPageModel {
	readonly schema: typeof STATUS_PAGE_SCHEMA;
	readonly scope: StatusScope;
	readonly generatedAt: string;
	readonly overall: {
		readonly indicator: OverallIndicator;
		readonly description: string;
	};
	readonly components: readonly ComponentStatusRecord[];
	readonly activeIncidents: readonly IncidentRecord[];
	readonly recentIncidents: readonly IncidentRecord[];
	readonly maintenances: readonly MaintenanceRecord[];
	readonly freshness: {
		readonly budgetMs: number;
		readonly staleComponentIds: readonly string[];
	};
	readonly contentHash?: `sha256:${string}`;
}

export function isRecordValue(input: JsonValue): input is JsonObject {
	return (
		Object.prototype.toString.call(input) === "[object Object]" &&
		input !== null
	);
}

export function isStringValue(input: JsonValue | undefined): input is string {
	return (
		Object.prototype.toString.call(input) === "[object String]" &&
		Object(input) !== input
	);
}

function expectRecord(input: JsonValue, path: string): JsonObject {
	if (!isRecordValue(input)) {
		throw new StatusPageParseError(path, "expected an object");
	}
	return input;
}

function expectString(input: JsonValue | undefined, path: string): string {
	if (!isStringValue(input) || input.length === 0) {
		throw new StatusPageParseError(path, "expected a non-empty string");
	}
	return input;
}

function expectIso(input: JsonValue | undefined, path: string): string {
	const value = expectString(input, path);
	if (Number.isNaN(Date.parse(value))) {
		throw new StatusPageParseError(path, "expected an ISO-8601 timestamp");
	}
	return value;
}

function expectEnum<T extends string>(
	input: JsonValue | undefined,
	values: readonly T[],
	path: string,
): T {
	const value = expectString(input, path);
	const match = values.find((candidate) => candidate === value);
	if (match === undefined) {
		throw new StatusPageParseError(
			path,
			`expected one of ${values.join(", ")} (got "${value}")`,
		);
	}
	return match;
}

function expectStringArray(
	input: JsonValue | undefined,
	path: string,
): readonly string[] {
	if (!Array.isArray(input)) {
		throw new StatusPageParseError(path, "expected an array of strings");
	}
	return Object.freeze(
		input.map((item, index) => expectString(item, `${path}[${index}]`)),
	);
}

export function parseStatusScope(input: JsonValue): StatusScope {
	const raw = expectRecord(input, "scope");
	const kind = expectEnum(raw.kind, STATUS_SCOPE_KINDS, "scope.kind");
	const id = expectString(raw.id, "scope.id");
	if (!ID_PATTERN.test(id)) {
		throw new StatusPageParseError(
			"scope.id",
			`must match ${ID_PATTERN} (got "${id}")`,
		);
	}
	return Object.freeze({
		kind,
		id,
		label: expectString(raw.label, "scope.label"),
	});
}

export function parseComponentSpec(input: JsonValue): ComponentSpec {
	const raw = expectRecord(input, "component");
	const id = expectString(raw.id, "component.id");
	if (!ID_PATTERN.test(id)) {
		throw new StatusPageParseError(
			"component.id",
			`must match ${ID_PATTERN} (got "${id}")`,
		);
	}
	// SAFETY: every field is parsed immediately above, and the optional description is added only after parsing.
	const result: ParsedComponent = {
		id,
		label: expectString(raw.label, "component.label"),
		kind: expectEnum(raw.kind, COMPONENT_KINDS, "component.kind"),
	};
	if (raw.description !== undefined) {
		result.description = expectString(raw.description, "component.description");
	}
	return Object.freeze(result);
}

export function parseIncidentRecord(input: JsonValue): IncidentRecord {
	const raw = expectRecord(input, "incident");
	const id = expectString(raw.id, "incident.id");
	if (!INCIDENT_ID_PATTERN.test(id)) {
		throw new StatusPageParseError(
			"incident.id",
			`must match ${INCIDENT_ID_PATTERN} (got "${id}")`,
		);
	}
	const state = expectEnum(raw.state, INCIDENT_STATES, "incident.state");
	const updatesRaw = Array.isArray(raw.updates) ? raw.updates : [];
	const updates = Object.freeze(
		updatesRaw.map((update, index) => {
			const record = expectRecord(update, `incident.updates[${index}]`);
			return Object.freeze({
				state: expectEnum(
					record.state,
					INCIDENT_STATES,
					`incident.updates[${index}].state`,
				),
				body: expectString(record.body, `incident.updates[${index}].body`),
				at: expectIso(record.at, `incident.updates[${index}].at`),
				public: record.public === true,
			});
		}),
	);
	const resolvedAt =
		raw.resolvedAt !== undefined
			? expectIso(raw.resolvedAt, "incident.resolvedAt")
			: undefined;
	if (state === "resolved" && resolvedAt === undefined) {
		throw new StatusPageParseError(
			"incident.resolvedAt",
			"resolved incidents must carry resolvedAt",
		);
	}
	// SAFETY: every field is parsed immediately above, and resolvedAt is added only after the state invariant.
	const result: ParsedIncident = {
		id,
		title: expectString(raw.title, "incident.title"),
		state,
		impact: expectEnum(raw.impact, INCIDENT_IMPACTS, "incident.impact"),
		affectedComponents: expectStringArray(
			raw.affectedComponents,
			"incident.affectedComponents",
		),
		openedAt: expectIso(raw.openedAt, "incident.openedAt"),
		updatedAt: expectIso(raw.updatedAt, "incident.updatedAt"),
		updates,
	};
	if (resolvedAt !== undefined) result.resolvedAt = resolvedAt;
	return Object.freeze(result);
}

export function parseMaintenanceRecord(input: JsonValue): MaintenanceRecord {
	const raw = expectRecord(input, "maintenance");
	const id = expectString(raw.id, "maintenance.id");
	if (!INCIDENT_ID_PATTERN.test(id)) {
		throw new StatusPageParseError(
			"maintenance.id",
			`must match ${INCIDENT_ID_PATTERN} (got "${id}")`,
		);
	}
	const windowStart = expectIso(raw.windowStart, "maintenance.windowStart");
	const windowEnd = expectIso(raw.windowEnd, "maintenance.windowEnd");
	if (Date.parse(windowEnd) < Date.parse(windowStart)) {
		throw new StatusPageParseError(
			"maintenance.windowEnd",
			"window must end at or after windowStart",
		);
	}
	return Object.freeze({
		id,
		title: expectString(raw.title, "maintenance.title"),
		state: expectEnum(raw.state, MAINTENANCE_STATES, "maintenance.state"),
		windowStart,
		windowEnd,
		affectedComponents: expectStringArray(
			raw.affectedComponents,
			"maintenance.affectedComponents",
		),
		expectedImpact: expectString(
			raw.expectedImpact,
			"maintenance.expectedImpact",
		),
	});
}

/** Forward-only maintenance transition guard. */
export function advanceMaintenanceState(
	current: MaintenanceState,
	next: MaintenanceState,
): MaintenanceState {
	return MAINTENANCE_STATE_RANK[next] >= MAINTENANCE_STATE_RANK[current]
		? next
		: current;
}

/** Forward-only incident transition guard. */
export function advanceIncidentState(
	current: IncidentState,
	next: IncidentState,
): IncidentState {
	return INCIDENT_STATE_RANK[next] >= INCIDENT_STATE_RANK[current]
		? next
		: current;
}
