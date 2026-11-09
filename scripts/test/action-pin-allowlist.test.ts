import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isActionPinAllowlisted,
	loadActionPinAllowlist,
	verifyPinnedActionSha,
} from "../lib/verify-action-pins.mts";

const root = join(import.meta.dirname, "..", "..");

function collectPinnedFromText(text: string): Map<string, Set<string>> {
	const byRepo = new Map<string, Set<string>>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\s*-?\s*uses:\s*([^@\s]+)@([0-9a-f]{40})\s*$/);
		if (!match) continue;
		const action = match[1];
		const sha = match[2];
		if (!action || !sha || action.startsWith("./")) continue;
		const segments = action.split("/");
		const repo =
			segments.length >= 2
				? `${segments[0]}/${segments[1]}`
				: `actions/${action}`;
		const shas = byRepo.get(repo) ?? new Set<string>();
		shas.add(sha);
		byRepo.set(repo, shas);
	}
	return byRepo;
}

function walkGithubYaml(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			walkGithubYaml(path, out);
			continue;
		}
		if (/\.ya?ml$/i.test(name)) out.push(path);
	}
	return out;
}

describe("action-pin-allowlist.json", () => {
	it("covers every SHA-pinned third-party action under .github/", () => {
		const allowlist = loadActionPinAllowlist();
		const githubRoot = join(root, ".github");
		const missing: string[] = [];
		for (const file of walkGithubYaml(githubRoot)) {
			const text = readFileSync(file, "utf8");
			for (const [repo, shas] of collectPinnedFromText(text)) {
				for (const sha of shas) {
					if (!allowlist[repo]?.includes(sha)) {
						missing.push(`${repo}@${sha} (${file})`);
					}
				}
			}
		}
		expect(missing, missing.join("\n")).toEqual([]);
	});

	it("accepts allowlisted pins without network", async () => {
		expect(
			isActionPinAllowlisted(
				"actions/checkout",
				"11bd71901bbe5b1630ceea73d27597364c9af683",
			),
		).toBe(true);
		expect(
			await verifyPinnedActionSha(
				"actions/checkout",
				"11bd71901bbe5b1630ceea73d27597364c9af683",
				"test",
				{},
			),
		).toBeUndefined();
	});
});
