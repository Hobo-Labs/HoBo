#!/usr/bin/env node
/**
 * Create a signed release tag at a commit when absent (never moves/deletes tags).
 *
 * The tag object is written and signed here, not by `git tag -s`: the release
 * runners have no OpenSSH client for git to sign with (the runner image
 * installs packages without recommends), and no git identity either. The
 * signature is the same sshsig git writes for `gpg.format = ssh`, so
 * `git verify-tag` with an allowed_signers file checks it as usual.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseRef } from "../lib/release-version.mts";
import {
	type Ed25519Key,
	parseEd25519PublicLine,
	parseOpenSshEd25519PrivateKey,
	sshSign,
} from "../lib/ssh-sig.mts";

/** Who the release tag names as its tagger. */
export const RELEASE_TAGGER =
	"github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";

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

/** The release signing key, checked against the published signing key when one is given. */
export function releaseSigningKey(env: NodeJS.ProcessEnv): Ed25519Key {
	const keyMaterial = env.HOBO_RELEASE_TAG_SSH_PRIVATE_KEY?.trim();
	if (!keyMaterial) {
		throw new Error(
			"HOBO_RELEASE_TAG_SSH_PRIVATE_KEY is required (an unencrypted OpenSSH ed25519 private key)",
		);
	}
	const key = parseOpenSshEd25519PrivateKey(keyMaterial);
	const published = env.HOBO_RELEASE_TAG_SSH_SIGNING_KEY?.trim();
	if (published?.includes("ssh-ed25519")) {
		const expected = parseEd25519PublicLine(published);
		if (!expected.equals(key.publicKey)) {
			throw new Error(
				"HOBO_RELEASE_TAG_SSH_SIGNING_KEY is not the public half of HOBO_RELEASE_TAG_SSH_PRIVATE_KEY",
			);
		}
	}
	return key;
}

/** The unsigned body of an annotated tag object (what the signature covers). */
export function tagPayload(options: {
	readonly commit: string;
	readonly tag: string;
	readonly tagger: string;
	readonly epochSeconds: number;
	readonly message: string;
}): string {
	return [
		`object ${options.commit}`,
		"type commit",
		`tag ${options.tag}`,
		`tagger ${options.tagger} ${options.epochSeconds} +0000`,
		"",
		`${options.message.replace(/\n*$/u, "")}\n`,
	].join("\n");
}

/** A signed tag object: the payload with its sshsig appended, as git writes it. */
export function signedTagObject(payload: string, key: Ed25519Key): string {
	return `${payload}${sshSign(Buffer.from(payload, "utf8"), key)}`;
}

function writeTag(tag: string, object: string): string {
	const made = spawnSync("git", ["mktag"], {
		cwd: root,
		input: object,
		encoding: "utf8",
	});
	if (made.status !== 0) {
		throw new Error(`git mktag failed: ${made.stderr || made.stdout}`);
	}
	const sha = (made.stdout ?? "").trim();
	runGit(["update-ref", `refs/tags/${tag}`, sha, ""]);
	return sha;
}

function pushTagOverHttps(tag: string, env: NodeJS.ProcessEnv): void {
	const token = env.GITHUB_TOKEN?.trim();
	const repository = env.GITHUB_REPOSITORY?.trim();
	if (!token || !repository) {
		throw new Error(
			"GITHUB_TOKEN and GITHUB_REPOSITORY are required to push tags over HTTPS (deploy keys cannot push)",
		);
	}
	const url = `https://x-access-token:${token}@github.com/${repository}.git`;
	const result = spawnSync("git", ["push", url, `refs/tags/${tag}`], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`git push (HTTPS) failed: ${result.stderr || result.stdout}`,
		);
	}
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
		// An annotated tag resolves to its tag object; the commit is what has to match.
		const existing = runGit(["rev-parse", `${tag}^{commit}`]).trim();
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
	const key = releaseSigningKey(process.env);
	const payload = tagPayload({
		commit: commitSha,
		tag,
		tagger: process.env.HOBO_RELEASE_TAGGER?.trim() || RELEASE_TAGGER,
		epochSeconds: Math.floor(Date.now() / 1000),
		message: `HoBo release ${tag}`,
	});
	writeTag(tag, signedTagObject(payload, key));
	pushTagOverHttps(tag, process.env);
	console.log(`pushed signed tag ${tag} -> ${commitSha} (HTTPS)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
