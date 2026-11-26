/**
 * What the reader and the system `tar` each make of one archive, for the
 * tests that hold the reader to `tar`: the reader's answer (the member's
 * sha256 or the code it refused with) and what `tar -xzf` leaves at the
 * member's path, extracting the whole archive or only the member.
 */
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PinsError } from "../../lib/pins.ts";
import { memberDigest } from "../../lib/pins-archive.ts";
import { scratch, sha256Hex } from "./pins-support.ts";

export const GOOD = Buffer.from("#!/bin/sh\necho GOOD\n");
export const EVIL = Buffer.from("#!/bin/sh\necho EVIL\n");
const NAMES = new Map([
	[sha256Hex(GOOD), "GOOD"],
	[sha256Hex(EVIL), "EVIL"],
]);

/** GOOD or EVIL for their digests, anything else as it is. */
export const label = (answer: string): string => NAMES.get(answer) ?? answer;

/** True when `answer` is a member's sha256, not a refusal. */
export const accepted = (answer: string): boolean =>
	/^[0-9a-f]{64}$/u.test(answer);

/** The reader's answer: the member's sha256, or the code it refused with. */
export async function readerSays(
	path: string,
	member: string,
): Promise<string> {
	try {
		return (await memberDigest(path, member)).member;
	} catch (error) {
		if (error instanceof PinsError) return error.code;
		throw error;
	}
}

/**
 * Why the comparisons with GNU tar cannot run under `env`, or `false` when
 * they can. GNU tar is the reference, so `tar --version` must run and say
 * "GNU tar": any other tar on PATH (bsdtar among them) is named by its own
 * banner and never compared against.
 */
export function gnuTarMissing(
	env: NodeJS.ProcessEnv = process.env,
): string | false {
	const probe = spawnSync("tar", ["--version"], { encoding: "utf8", env });
	if (probe.error !== undefined || probe.status !== 0) {
		return "no `tar` on PATH, so there is nothing to compare the reader with";
	}
	if (/GNU tar/u.test(probe.stdout)) return false;
	const banner = probe.stdout.split("\n")[0]?.trim() || "no version banner";
	return `the tar on PATH is not GNU tar (it says ${JSON.stringify(banner)}), and GNU tar is the reference these comparisons hold the reader to`;
}

/** `false` when GNU tar is on PATH, else why every comparison with it is skipped. */
export const noGnuTar = gnuTarMissing();

/** What is at `at` after an extract: a regular file's sha256, or what is there instead. */
function leftAt(at: string): string {
	try {
		const stat = lstatSync(at);
		if (stat.isFile()) return sha256Hex(readFileSync(at));
		return stat.isDirectory() ? "a directory" : "not a regular file";
	} catch {
		return "nothing";
	}
}

/** `tar`'s exit status for `args`, or -1 when it was killed or could not start. */
function tarStatus(args: readonly string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn("tar", args, { stdio: "ignore" });
		child.once("error", () => resolve(-1));
		child.once("close", (code) => resolve(code ?? -1));
	});
}

/** What `tar` leaves at `member`, and its exit status when not 0. */
export async function tarLeaves(
	path: string,
	member: string,
	named: boolean,
): Promise<string> {
	const into = join(scratch("tar-diff-out"), "x");
	mkdirSync(into);
	const args = ["-xzf", path, "-C", into, ...(named ? [member] : [])];
	const status = await tarStatus(args);
	const found = leftAt(join(into, member));
	return status === 0 ? found : `${label(found)} (tar exit ${status})`;
}

/**
 * Where the reader accepted `path` and named `answer`, each extract that left
 * anything else at the member, as one line per extract; nothing when it agrees.
 */
export async function disagreements(
	what: string,
	path: string,
	member: string,
	answer: string,
): Promise<string[]> {
	const found: string[] = [];
	for (const named of [false, true]) {
		const left = await tarLeaves(path, member, named);
		if (left !== answer) {
			found.push(
				`${what} (${named ? `tar -xzf A ${member}` : "tar -xzf A"}): the reader names ${label(answer)}, tar leaves ${label(left)}`,
			);
		}
	}
	return found;
}

/** `disagreements` for many archives, eight `tar` runs at a time. */
export async function allDisagreements(
	cases: readonly {
		readonly what: string;
		readonly path: string;
		readonly member: string;
		readonly answer: string;
	}[],
): Promise<string[]> {
	const found: string[] = [];
	for (let start = 0; start < cases.length; start += 8) {
		const batch = cases.slice(start, start + 8);
		const results = await Promise.all(
			batch.map((c) => disagreements(c.what, c.path, c.member, c.answer)),
		);
		found.push(...results.flat());
	}
	return found;
}
