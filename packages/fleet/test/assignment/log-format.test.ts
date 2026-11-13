/**
 * The stored log stays readable both ways (design §6.10, O15).
 *
 * With membership epochs off, a log written by today's encoder decodes and
 * re-encodes to the same bytes, and today's decoder (copied as a fixture)
 * reads every log the new code writes. Once an entry carries a member set the
 * log is format 2, which today's decoder refuses, and the new decoder refuses
 * a member set under format 1.
 */
import { parseEphemeralKey } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	bootstrapAssignment,
	completeAssignment,
	decodeAssignmentLog,
	encodeAssignmentLog,
	overrideAssignment,
	parseAssignmentEntry,
	proposeAssignment,
} from "../../src/assignment/index.js";
import { type MemberName, parseMemberName } from "../../src/ids.js";
import type { AssignmentEntry } from "../../src/ports.js";
import { cacheFleet, LOG_KEY, writer } from "./fixtures.js";
import {
	decodeTodayLog,
	encodeTodayLog,
	type TodayEntry,
} from "./today-log.js";

const name = fc
	.stringMatching(/^[a-z0-9][a-z0-9_-]{0,12}$/u)
	.map((value) => parseMemberName(value));
const reason = fc.stringMatching(/^[a-z0-9][a-z0-9:._ -]{0,30}$/u);
const author = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,20}$/u);
const ms = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/** One entry's value, without its epoch; always a valid entry. */
const value = fc
	.record({
		active: fc.option(name, { nil: undefined }),
		target: name,
		sealed: fc.boolean(),
		reason,
		lossWindowMs: fc.option(ms, { nil: undefined }),
		decidedAtMs: ms,
		decidedBy: author,
	})
	.filter((entry) => !entry.sealed || entry.target !== entry.active)
	.map((entry) => ({
		...entry,
		target: entry.sealed ? entry.target : undefined,
	}));

/** A contiguous log of entries without member sets, as today writes them. */
const todayLog = fc
	.tuple(
		fc.integer({ min: 1, max: 1_000_000 }),
		fc.array(value, { minLength: 0, maxLength: 8 }),
	)
	.map(([first, values]) =>
		values.map(
			(entry, index): TodayEntry => ({ ...entry, epoch: first + index }),
		),
	);

function parsed(entry: TodayEntry): AssignmentEntry {
	return parseAssignmentEntry({
		...entry,
		active:
			entry.active === undefined ? undefined : parseMemberName(entry.active),
		target:
			entry.target === undefined ? undefined : parseMemberName(entry.target),
		members: undefined,
	});
}

function plain(entry: AssignmentEntry): TodayEntry {
	const { members, ...rest } = entry;
	expect(members).toBeUndefined();
	return rest;
}

const members = (...names: string[]): MemberName[] =>
	names.map((each) => parseMemberName(each));

describe("format 1: today's bytes, both ways", () => {
	it("decodes what today's encoder wrote and re-encodes the same bytes", () => {
		fc.assert(
			fc.property(todayLog, (entries) => {
				const stored = encodeTodayLog(entries);
				const decoded = decodeAssignmentLog(stored);
				expect(decoded.map(plain)).toEqual(entries);
				expect(encodeAssignmentLog(decoded)).toBe(stored);
			}),
			{ numRuns: 500 },
		);
	});

	it("writes logs today's decoder reads, entry for entry", () => {
		fc.assert(
			fc.property(todayLog, (entries) => {
				const stored = encodeAssignmentLog(entries.map(parsed));
				expect(stored).toContain('"format":1');
				expect(decodeTodayLog(stored)).toEqual(entries);
			}),
			{ numRuns: 500 },
		);
	});

	it("keeps today's bytes for the pinned bootstrap entry", () => {
		const bootstrap = parsed({
			epoch: 1,
			active: "upstash",
			sealed: false,
			target: undefined,
			reason: "bootstrap",
			lossWindowMs: undefined,
			decidedAtMs: 0,
			decidedBy: "bootstrap",
		});
		expect(encodeAssignmentLog([bootstrap])).toBe(
			'{"format":1,"entries":[{"epoch":"1","active":"upstash","reason":"bootstrap","decidedBy":"bootstrap"}]}',
		);
	});

	it("leaves every log the register writes readable by today's decoder", async () => {
		const fleet = cacheFleet(3, 4);
		await bootstrapAssignment(fleet.register, parseMemberName("c0"));
		for (let epoch = 1; epoch <= 6; epoch += 1)
			await proposeAssignment(fleet.register, {
				expectedEpoch: epoch,
				value: writer(`c${epoch % 3}`),
				decidedBy: "test",
				nowMs: epoch,
			});
		await overrideAssignment(fleet.register, {
			value: { ...writer("c1"), reason: "operator-override" },
			decidedBy: "operator",
			nowMs: 9,
		});
		await completeAssignment(fleet.register);
		for (const backend of fleet.backends) {
			const stored = await backend.state.get(parseEphemeralKey(LOG_KEY));
			if (stored === undefined) throw new Error(`${backend.id} holds no log`);
			const today = decodeTodayLog(stored.value);
			expect(today.map((entry) => entry.epoch)).toEqual([5, 6, 7, 8]);
			expect(decodeAssignmentLog(stored.value).map(plain)).toEqual(today);
		}
	});
});

describe("format 2: member sets", () => {
	const pin = parseAssignmentEntry({
		epoch: 4,
		active: parseMemberName("c0"),
		sealed: false,
		target: undefined,
		reason: "pin-members",
		lossWindowMs: undefined,
		decidedAtMs: 7,
		decidedBy: "service:relay",
		members: members("c0", "c1", "c2"),
	});
	const before = parseAssignmentEntry({
		...pin,
		epoch: 3,
		reason: "keep",
		members: undefined,
	});

	it("is written once any entry carries a member set, and round-trips", () => {
		const stored = encodeAssignmentLog([before, pin]);
		expect(stored).toContain('"format":2');
		expect(stored).toContain('"members":["c0","c1","c2"]');
		expect(decodeAssignmentLog(stored)).toEqual([before, pin]);
		expect(encodeAssignmentLog(decodeAssignmentLog(stored))).toBe(stored);
	});

	it("is refused by today's decoder, so an old reader never counts the wrong set", () => {
		// Refused on the unknown `members` field before its format check is reached.
		expect(() => decodeTodayLog(encodeAssignmentLog([before, pin]))).toThrow(
			/does not parse/u,
		);
		const formatOnly = encodeAssignmentLog([before, pin]).replace(
			/,"members":\[[^\]]*\]/u,
			"",
		);
		expect(() => decodeTodayLog(formatOnly)).toThrow(/unknown format/u);
	});

	it("refuses a member set under format 1, and any other format", () => {
		const stored = encodeAssignmentLog([pin]);
		expect(() =>
			decodeAssignmentLog(stored.replace('"format":2', '"format":1')),
		).toThrow(/format 1/u);
		expect(() =>
			decodeAssignmentLog(stored.replace('"format":2', '"format":3')),
		).toThrow(/unknown format/u);
		expect(() =>
			decodeAssignmentLog(stored.replace('"members"', '"memberz"')),
		).toThrow(/does not parse/u);
	});

	it("refuses numbers past the safe range and malformed member sets", () => {
		expect(() =>
			decodeAssignmentLog(
				'{"format":1,"entries":[{"epoch":"9007199254740993","reason":"x","decidedBy":"y"}]}',
			),
		).toThrow(/out of range/u);
		expect(() =>
			decodeAssignmentLog(
				'{"format":2,"entries":[{"epoch":"1","reason":"x","decidedBy":"y","members":["b","a"]}]}',
			),
		).toThrow(/sorted/u);
		expect(() =>
			decodeAssignmentLog(
				'{"format":2,"entries":[{"epoch":"1","reason":"x","decidedBy":"y","members":["No"]}]}',
			),
		).toThrow(/lower-case token/u);
	});
});
