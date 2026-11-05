#!/usr/bin/env node
/** Create a signed release tag at a commit when absent (never moves/deletes tags). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseRef } from "../lib/release-version.mts";

const root = join(import.meta.dirname, "..", "..");

function parseArgs(argv: string[]) {
	let tag = "";
	let commit = "HEAD";
	let dryRun = false;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--tag") tag = argv[++i] ?? "";
		else if (arg === "--commit") commit = argv[++i] ?? "HEAD";
		else if (arg === "--dry-run") dryRun = true;
	}
	if (!tag.trim()) {
		console.error(
			"usage: push-release-git-tag.mts --tag <v0.0.0-alpha.N> [--commit <rev>] [--dry-run]",
		);
		process.exit(2);
	}
	return { tag: tag.trim(), commit, dryRun };
}

function runGit(args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout ?? "";
}

function tagExists(tag: string): boolean {
	const result = spawnSync("git", ["rev-parse", `refs/tags/${tag}`], {
		cwd: root,
		encoding: "utf8",
	});
	return result.status === 0;
}

function configureSshTagSigning(env: NodeJS.ProcessEnv): void {
	const keyMaterial = env.HOBO_RELEASE_TAG_SSH_PRIVATE_KEY?.trim();
	const signingKey = env.HOBO_RELEASE_TAG_SSH_SIGNING_KEY?.trim();
	if (!keyMaterial || !signingKey) {
		throw new Error(
			"HOBO_RELEASE_TAG_SSH_PRIVATE_KEY and HOBO_RELEASE_TAG_SSH_SIGNING_KEY are required",
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "hobo-release-tag-sign-"));
	const keyPath = join(dir, "id_ed25519");
	writeFileSync(keyPath, `${keyMaterial}\n`, { mode: 0o600 });
	spawnSync("git", ["config", "gpg.format", "ssh"], { cwd: root });
	spawnSync("git", ["config", "user.signingkey", signingKey], { cwd: root });
	spawnSync("git", ["config", "tag.gpgSign", "true"], { cwd: root });
	spawnSync(
		"git",
		[
			"config",
			"core.sshCommand",
			`ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new`,
		],
		{ cwd: root },
	);
}

function main(): void {
	const { tag, commit, dryRun } = parseArgs(process.argv);
	const parsed = parseReleaseRef(tag);
	if (parsed.npmDistTag !== "alpha") {
		throw new Error(
			`refusing to create tag with npm dist-tag ${parsed.npmDistTag}`,
		);
	}
	if (parsed.train !== "full") {
		throw new Error(`refusing to create non-full train tag ${tag}`);
	}
	const commitSha = runGit(["rev-parse", commit]).trim();
	if (tagExists(tag)) {
		const existing = runGit(["rev-parse", tag]).trim();
		if (existing !== commitSha) {
			throw new Error(
				`tag ${tag} already points at ${existing}; refusing to move to ${commitSha}`,
			);
		}
		console.log(`tag ${tag} already exists at ${commitSha}; skip push`);
		return;
	}
	if (dryRun) {
		console.log(`would create signed tag ${tag} at ${commitSha}`);
		return;
	}
	configureSshTagSigning(process.env);
	const message = `HoBo release ${tag}`;
	const sign = spawnSync("git", ["tag", "-s", tag, "-m", message, commitSha], {
		cwd: root,
		encoding: "utf8",
	});
	if (sign.status !== 0) {
		throw new Error(`git tag failed: ${sign.stderr || sign.stdout}`);
	}
	runGit(["push", "origin", tag]);
	console.log(`pushed signed tag ${tag} -> ${commitSha}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
