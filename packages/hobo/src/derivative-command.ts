import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandModule, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT } from "@hobo/cli";
import {
	collectStream,
	derivativeUpgradeFailed,
	derivativeUpgradeStarted,
	derivativeUpgradeSucceeded,
} from "@hobo/cloud";
import type { EventEnvelope, EventInput, PrincipalRef } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { createUpcasterRegistry } from "@hobo/data";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export interface DerivativeCommandDeps {
	// The shared Yard runtime whose durable log records the upgrade ceremony and
	// holds the stored events the upcaster chain runs over.
	readonly runtime?: YardRuntime;
}

interface MutableJson {
	[key: string]: JsonValue;
}

const DERIVATIVE_ACTOR: PrincipalRef = { kind: "user", id: "user:derivative" };
const DESCRIPTOR_FILE = "derivative.json";

// domain-view: one pinned upcaster step in the derivative descriptor
// (parse-don't-validate). A declarative, PURE `vN -> vN+1` event-body
// transform: rename fields, drop fields, fill defaults. A bare string in
// derivative.json parses to a named-but-unbound step (no event binding, so it
// executes over zero events). Renames are strict — a missing source field is
// an execution failure, which is exactly how a broken upcaster surfaces in the
// conformance verdict.
export interface DerivativeUpcasterStep {
	readonly name: string;
	readonly event?: string;
	readonly fromVersion: number;
	readonly rename: Readonly<Record<string, string>>;
	readonly defaults: JsonObject;
	readonly drop: readonly string[];
}

// The derived-HoBo descriptor (parse-don't-validate). A fork declares its name,
// current version, the version it upgrades to, the pinned upcasters to run, and
// the stored streams those upcasters affect.
interface DerivativeDescriptor {
	readonly name: string;
	readonly version: string;
	readonly upgradeTo?: string;
	readonly upcasters: readonly DerivativeUpcasterStep[];
	readonly streams: readonly string[];
}

function parseUpcaster(
	raw: JsonValue | undefined,
	index: number,
): DerivativeUpcasterStep {
	if (isJsonString(raw)) {
		if (raw.length === 0) {
			throw new Error(`derivative.json.upcasters[${index}] must be non-empty`);
		}
		return { name: raw, fromVersion: 1, rename: {}, defaults: {}, drop: [] };
	}
	if (!isJsonObject(raw) || raw === null) {
		throw new Error(
			`derivative.json.upcasters[${index}] must be a string or object`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const doc = raw as {
		name?: unknown;
		event?: unknown;
		fromVersion?: unknown;
		rename?: unknown;
		defaults?: unknown;
		drop?: unknown;
	};
	if (!isJsonString(doc.name) || doc.name.length === 0) {
		throw new Error(
			`derivative.json.upcasters[${index}].name must be a non-empty string`,
		);
	}
	const fromVersion =
		doc.fromVersion === undefined ? 1 : Number(doc.fromVersion);
	if (!Number.isInteger(fromVersion) || fromVersion < 1) {
		throw new Error(
			`derivative.json.upcasters[${index}].fromVersion must be a positive integer`,
		);
	}
	const rename: Record<string, string> = {};
	if (doc.rename !== undefined) {
		if (!isJsonObject(doc.rename) || doc.rename === null) {
			throw new Error(
				`derivative.json.upcasters[${index}].rename must be an object`,
			);
		}
		for (const [from, to] of Object.entries(doc.rename)) {
			rename[from] = String(to);
		}
	}
	return {
		name: doc.name,
		...(isJsonString(doc.event) && doc.event.length > 0
			? { event: doc.event }
			: undefined),
		fromVersion,
		rename,
		defaults: isJsonObject(doc.defaults) ? { ...doc.defaults } : {},
		drop: Array.isArray(doc.drop) ? doc.drop.map((field) => String(field)) : [],
	};
}

function parseDescriptor(raw: JsonValue | undefined): DerivativeDescriptor {
	if (!isJsonObject(raw) || raw === null) {
		throw new Error("derivative.json must be a JSON object");
	}
	if (!isJsonString(raw.name) || raw.name.length === 0) {
		throw new Error("derivative.json.name must be a non-empty string");
	}
	if (!isJsonString(raw.version) || raw.version.length === 0) {
		throw new Error("derivative.json.version must be a non-empty string");
	}
	const upcasters = Array.isArray(raw.upcasters)
		? raw.upcasters.map((upcaster, index) => parseUpcaster(upcaster, index))
		: [];
	const streams = Array.isArray(raw.streams)
		? raw.streams.map((stream) => String(stream))
		: [];
	return {
		name: raw.name,
		version: raw.version,
		...(isJsonString(raw.upgradeTo) ? { upgradeTo: raw.upgradeTo } : undefined),
		upcasters,
		streams,
	};
}

// Build the pure event-body transform a declarative step pins. Strict renames:
// upcasting a body that lacks a renamed source field is a FAILURE (the
// upcaster does not fit the stored corpus), never a silent skip.
function transformFor(
	step: DerivativeUpcasterStep,
): (data: JsonValue) => JsonValue {
	return (data: JsonValue): JsonValue => {
		if (!isJsonObject(data) || Array.isArray(data)) {
			throw new Error(
				`upcaster ${step.name}: event body must be an object, got ${Array.isArray(data) ? "array" : "scalar"}`,
			);
		}
		const body: MutableJson = Object.assign({}, data);
		for (const [from, to] of Object.entries(step.rename)) {
			if (!Object.hasOwn(body, from)) {
				throw new Error(
					`upcaster ${step.name}: cannot rename missing field "${from}"`,
				);
			}
			const renamed = body[from];
			if (renamed === undefined) {
				throw new Error(
					`upcaster ${step.name}: cannot rename missing field "${from}"`,
				);
			}
			body[to] = renamed;
			delete body[from];
		}
		for (const field of step.drop) {
			delete body[field];
		}
		for (const [field, value] of Object.entries(step.defaults)) {
			if (!Object.hasOwn(body, field)) {
				body[field] = value;
			}
		}
		return body;
	};
}

function canonicalJson(value: JsonValue | undefined): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value && isJsonObject(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return `{${Object.keys(value as JsonObject)
			.sort()
			.map(
				(key) =>
					// SAFETY: assertion required at this I/O or test boundary.
					`${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

// domain-view: one executed upcast over a stored event — proof the chain ran,
// with the version bump it produced.
export interface UpcastedEventRecord {
	readonly stream: string;
	readonly seq: number;
	readonly type: string;
	readonly fromVersion: number;
	readonly toVersion: number;
}

interface SeamConformance {
	readonly ok: boolean;
	readonly checkedEvents: number;
	readonly upcastedEvents: number;
	readonly errors: readonly string[];
}

// Execute the pinned upcaster chain over the affected stored events and derive
// the seam-conformance verdict from what ACTUALLY happened:
//   - every affected event must reach the chain's latest version,
//   - every transform must be pure (same input twice -> same output),
//   - a transform that throws (e.g. a strict rename over a body missing the
//     field) fails the verdict.
// History is never rewritten — upcasting is a read-side derivation; the
// ceremony proves the chain replays the real corpus before the fork upgrades.
async function executeUpcasters(
	store: YardRuntime["store"],
	descriptor: DerivativeDescriptor,
): Promise<{
	conformance: SeamConformance;
	upcasted: readonly UpcastedEventRecord[];
}> {
	const registry = createUpcasterRegistry();
	const errors: string[] = [];
	const boundTypes = new Set<string>();
	for (const step of descriptor.upcasters) {
		if (step.event === undefined) {
			continue;
		}
		boundTypes.add(step.event);
		try {
			registry.register(step.event, step.fromVersion, (data) =>
				transformFor(step)(cloneAsJson(data)),
			);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			errors.push(`upcaster ${step.name}: ${(error as Error).message}`);
		}
	}
	// Chain totality per bound type: every registered step must be reachable by
	// chaining v1..latest (a gap strands the steps above it).
	for (const step of descriptor.upcasters) {
		if (step.event === undefined) {
			continue;
		}
		const latest = registry.latestVersion(step.event);
		if (step.fromVersion >= latest) {
			errors.push(
				`upcaster ${step.name}: non-total chain for ${step.event} — v${step.fromVersion} is unreachable (chain stops at v${latest})`,
			);
		}
	}

	let checkedEvents = 0;
	const upcasted: UpcastedEventRecord[] = [];
	for (const stream of descriptor.streams) {
		let events: EventEnvelope[];
		try {
			events = await collectStream(store, stream);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			errors.push(`stream ${stream}: ${(error as Error).message}`);
			continue;
		}
		for (const event of events) {
			if (!boundTypes.has(event.type)) {
				continue;
			}
			checkedEvents += 1;
			const latest = registry.latestVersion(event.type);
			if (event.v >= latest) {
				continue;
			}
			try {
				const once = registry.upcast(event);
				const twice = registry.upcast(event);
				if (
					canonicalJson(cloneAsJson(once.data)) !==
					canonicalJson(cloneAsJson(twice.data))
				) {
					errors.push(
						`impure upcaster chain for ${event.type}@v${event.v} (${stream}#${event.seq}): identical input produced different output`,
					);
					continue;
				}
				if (once.v !== latest) {
					errors.push(
						`${event.type}@v${event.v} (${stream}#${event.seq}) only reached v${once.v}, expected v${latest}`,
					);
					continue;
				}
				upcasted.push({
					stream,
					seq: event.seq,
					type: event.type,
					fromVersion: event.v,
					toVersion: once.v,
				});
			} catch (error) {
				errors.push(
					// SAFETY: assertion required at this I/O or test boundary.
					`${event.type}@v${event.v} (${stream}#${event.seq}): ${(error as Error).message}`,
				);
			}
		}
	}

	return {
		conformance: {
			ok: errors.length === 0,
			checkedEvents,
			upcastedEvents: upcasted.length,
			errors,
		},
		upcasted,
	};
}

// `hobo derivative <read|upgrade>` — manage a derived HoBo implementation (a
// long-lived fork) via its `derivative.json` descriptor (ADR-0057).
//   read    — load + report the descriptor.
//   upgrade — the upgrade ceremony: check the descriptor's compat (a valid
//             from -> to version step), record `derivative.UpgradeStarted`,
//             EXECUTE the pinned event-body upcaster chain over the affected
//             stored events (descriptor `streams`), derive the seam-conformance
//             verdict from that execution, and record
//             `derivative.UpgradeSucceeded` or `derivative.UpgradeFailed` on
//             the durable log accordingly.
// Reads the local descriptor + event store; no cloud call, no credential.
// HONEST SCOPE: upcaster execution and the seam-conformance verdict are REAL —
// the chain runs over the stored corpus and a failing/impure/non-total
// upcaster fails the ceremony. Upcasting stays a read-side derivation (history
// is never rewritten); a bare-string upcaster pins a name without an event
// binding and therefore executes over zero events.
export function createDerivativeCommand(
	deps: DerivativeCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo derivative has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "derivative" },
				};
			}

			const sub = args[0] ?? "read";
			if (sub !== "read" && sub !== "upgrade") {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_DERIVATIVE_USAGE",
					message: `hobo derivative: unknown subcommand "${sub}". Use \`read\` or \`upgrade\`.`,
					remediation: [
						"Try `hobo derivative read` or `hobo derivative upgrade`.",
					],
					data: { command: "derivative" },
				};
			}

			// The derivative descriptor lives at the invocation directory (a fork
			// need not be a Bindle project), so read from the actual cwd rather than
			// a discovered project root.
			const dir = flags.cwd ?? context.cwd;
			let descriptor: DerivativeDescriptor;
			try {
				const raw = await readFile(path.join(dir, DESCRIPTOR_FILE), "utf8");
				descriptor = parseDescriptor(JSON.parse(raw));
			} catch (error) {
				return {
					ok: false,
					status: "no_descriptor",
					code: "HOBO_DERIVATIVE_NO_DESCRIPTOR",
					// SAFETY: assertion required at this I/O or test boundary.
					message: `hobo derivative: could not read ${DESCRIPTOR_FILE}: ${(error as Error).message}`,
					remediation: [
						`Add a ${DESCRIPTOR_FILE} with { name, version, upgradeTo, upcasters, streams }.`,
					],
					data: { command: "derivative" },
				};
			}

			if (sub === "read") {
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo derivative: "${descriptor.name}" v${descriptor.version} (${descriptor.upcasters.length} upcaster(s))`,
					data: { command: "derivative", subcommand: "read", descriptor },
				};
			}

			// upgrade ceremony.
			const toVersion = args[1] ?? descriptor.upgradeTo;
			const stream = `derivative:${descriptor.name}`;
			const existing = await collectStream(runtime.store, stream);
			let seq =
				existing.length > 0 ? must(existing[existing.length - 1]).seq : 0;
			const append = async (event: EventInput) => {
				const result = await runtime.store.append(stream, [event], {
					expectedSeq: seq,
					actor: DERIVATIVE_ACTOR,
					tenant: DEFAULT_TENANT,
				});
				const last = result.appended[result.appended.length - 1];
				if (last) seq = last.seq;
			};

			if (!toVersion || toVersion === descriptor.version) {
				await append(
					derivativeUpgradeFailed({
						name: descriptor.name,
						reason: toVersion
							? `already at ${toVersion}`
							: "no upgrade target (pass a version or set upgradeTo)",
					}),
				);
				return {
					ok: false,
					status: "upgrade_failed",
					code: "HOBO_DERIVATIVE_UPGRADE_FAILED",
					message: toVersion
						? `hobo derivative upgrade: "${descriptor.name}" is already at ${toVersion}.`
						: "hobo derivative upgrade: no upgrade target (pass a version or set upgradeTo).",
					data: {
						command: "derivative",
						subcommand: "upgrade",
						name: descriptor.name,
					},
				};
			}

			emitProgress(
				`upgrade ${descriptor.name}: ${descriptor.version} -> ${toVersion}`,
			);
			const upcasterNames = descriptor.upcasters.map((step) => step.name);
			await append(
				derivativeUpgradeStarted({
					name: descriptor.name,
					fromVersion: descriptor.version,
					toVersion,
					upcasters: upcasterNames,
				}),
			);

			// EXECUTE the pinned upcaster chain over the affected stored events and
			// rerun the seam-conformance check on the actual results.
			const { conformance, upcasted } = await executeUpcasters(
				runtime.store,
				descriptor,
			);
			for (const step of descriptor.upcasters) {
				const affected = upcasted.filter(
					(record) => step.event !== undefined && record.type === step.event,
				).length;
				emitProgress(
					`upcaster ${step.name}: ${step.event === undefined ? "unbound (0 events)" : `${affected} event(s)`}`,
				);
			}

			if (!conformance.ok) {
				await append(
					derivativeUpgradeFailed({
						name: descriptor.name,
						reason: `seam conformance failed: ${conformance.errors.join("; ")}`,
					}),
				);
				return {
					ok: false,
					status: "upgrade_failed",
					code: "HOBO_DERIVATIVE_UPGRADE_FAILED",
					message: `hobo derivative upgrade: "${descriptor.name}" ${descriptor.version} -> ${toVersion} FAILED seam conformance (${conformance.errors.length} error(s)).`,
					remediation: [
						"Fix the pinned upcasters so the chain replays the stored corpus, then rerun `hobo derivative upgrade`.",
					],
					data: {
						command: "derivative",
						subcommand: "upgrade",
						name: descriptor.name,
						fromVersion: descriptor.version,
						toVersion,
						conformance,
					},
				};
			}

			await append(
				derivativeUpgradeSucceeded({
					name: descriptor.name,
					toVersion,
					upcastersRun: upcasterNames,
				}),
			);

			return {
				ok: true,
				status: "upgraded",
				code: "HOBO_OK",
				message: `hobo derivative upgrade: "${descriptor.name}" ${descriptor.version} -> ${toVersion} (${upcasterNames.length} upcaster(s) run over ${conformance.upcastedEvents} stored event(s); seam conformance passed).`,
				data: {
					command: "derivative",
					subcommand: "upgrade",
					name: descriptor.name,
					fromVersion: descriptor.version,
					toVersion,
					upcastersRun: upcasterNames,
					upcasted,
					conformance,
				},
			};
		},
	};
}
