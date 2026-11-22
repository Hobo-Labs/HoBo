import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type Assignment,
	type AssignmentLog,
	AssignmentLogSchema,
	AssignmentSchema,
} from "../_generated/fleet_pb.js";
import { FleetParseError } from "../errors.js";
import { type MemberName, parseMemberName } from "../ids.js";
import type { AssignmentEntry } from "../ports.js";
import { parseAssignmentEntry } from "./register.js";

const FORMAT_WITHOUT_MEMBERS = 1;
const FORMAT_WITH_MEMBERS = 2;

function recordError(message: string): never {
	throw new FleetParseError("assignment_log", message);
}

function toWire(entry: AssignmentEntry): Assignment {
	return create(AssignmentSchema, {
		epoch: BigInt(entry.epoch),
		active: entry.active,
		sealed: entry.sealed,
		target: entry.target,
		reason: entry.reason,
		lossWindowMs:
			entry.lossWindowMs === undefined ? undefined : BigInt(entry.lossWindowMs),
		decidedAtMs: BigInt(entry.decidedAtMs),
		decidedBy: entry.decidedBy,
		members: entry.members === undefined ? [] : [...entry.members],
	});
}

function safeNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		recordError("stored assignment log carries a number out of range");
	return Number(value);
}

function fromWire(entry: Assignment, format: number): AssignmentEntry {
	if (format === FORMAT_WITHOUT_MEMBERS && entry.members.length > 0)
		recordError("a format 1 assignment log carries no member sets");
	const members: MemberName[] | undefined =
		entry.members.length === 0
			? undefined
			: entry.members.map((name) => parseMemberName(name, "members"));
	return parseAssignmentEntry({
		epoch: safeNumber(entry.epoch),
		active:
			entry.active === undefined
				? undefined
				: parseMemberName(entry.active, "active"),
		sealed: entry.sealed,
		target:
			entry.target === undefined
				? undefined
				: parseMemberName(entry.target, "target"),
		reason: entry.reason,
		lossWindowMs:
			entry.lossWindowMs === undefined
				? undefined
				: safeNumber(entry.lossWindowMs),
		decidedAtMs: safeNumber(entry.decidedAtMs),
		decidedBy: entry.decidedBy,
		members,
	});
}

export function encodeAssignmentLog(
	entries: readonly AssignmentEntry[],
): string {
	const withMembers = entries.some((entry) => entry.members !== undefined);
	return toJsonString(
		AssignmentLogSchema,
		create(AssignmentLogSchema, {
			format: withMembers ? FORMAT_WITH_MEMBERS : FORMAT_WITHOUT_MEMBERS,
			entries: entries.map(toWire),
		}),
	);
}

export function decodeAssignmentLog(value: string): AssignmentEntry[] {
	let log: AssignmentLog;
	try {
		log = fromJsonString(AssignmentLogSchema, value);
	} catch {
		return recordError("stored assignment log does not parse");
	}
	if (
		log.format !== FORMAT_WITHOUT_MEMBERS &&
		log.format !== FORMAT_WITH_MEMBERS
	)
		recordError("stored assignment log has an unknown format");
	const entries = log.entries.map((entry) => fromWire(entry, log.format));
	for (let index = 1; index < entries.length; index += 1)
		if (entries[index]?.epoch !== (entries[index - 1]?.epoch ?? 0) + 1)
			recordError("stored assignment log is not contiguous");
	return entries;
}
