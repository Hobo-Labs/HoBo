import { createPrivateKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGithubAppTransport } from "@hobo/ci-gh-actions/cli-serve";
import { z } from "zod";
import { parseJsonValue } from "./json.js";

const Version =
	/^([1-9]\d{0,15})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const App = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await checkPrivateDirectory(path);
}

async function checkPrivateDirectory(path: string): Promise<void> {
	const entry = await lstat(path);
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		(entry.mode & 0o077) !== 0
	)
		throw new Error("private credential directory required");
}

/** Check every ancestor, including worktrees whose .git entry is a file. */
export async function checkoutRoot(cwd: string): Promise<string | undefined> {
	let directory = await realpath(cwd);
	let found: string | undefined;
	for (;;) {
		try {
			const marker = join(directory, ".git");
			const entry = await lstat(marker);
			if (!entry.isFile()) await lstat(join(marker, "HEAD"));
			found = directory;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) return found;
		directory = parent;
	}
}

async function fileText(path: string, limit: number): Promise<string> {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > limit)
			throw new Error("invalid credential file");
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(
				buffer,
				length,
				buffer.length - length,
			);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > limit) throw new Error("invalid credential file");
		return buffer.subarray(0, length).toString("utf8");
	} finally {
		await file.close();
	}
}

async function appIdFromResponse(response: Response): Promise<number> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("empty App response");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > 65_536) {
				void reader.cancel().catch(() => undefined);
				throw new Error("App response too large");
			}
			chunks.push(part.value);
		}
		return App.parse(parseJsonValue(Buffer.concat(chunks).toString("utf8"))).id;
	} finally {
		reader.releaseLock();
	}
}

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

/** Store self-hosted App keys outside the checkout; never write them to output. */
export async function importGithubKey(input: {
	home: string;
	appId: string;
	keyFile: string;
	webhookSecretFile: string;
	fetch?: typeof fetch | undefined;
}): Promise<void> {
	if (process.platform === "win32")
		throw new Error("private key import requires POSIX file permissions");
	if (
		!/^[1-9]\d{0,15}$/.test(input.appId) ||
		!Number.isSafeInteger(Number(input.appId))
	)
		throw new Error("invalid App ID");
	const pem = await fileText(input.keyFile, 32_768);
	const secret = (await fileText(input.webhookSecretFile, 4096)).replace(
		/\r?\n$/,
		"",
	);
	const key = createPrivateKey(pem);
	if (
		key.asymmetricKeyType !== "rsa" ||
		(key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
		Buffer.byteLength(secret) < 32
	)
		throw new Error("invalid App key or webhook secret");
	const githubOptions: Parameters<typeof createGithubAppTransport>[0] = {
		appId: input.appId,
		privateKey: pem,
	};
	if (input.fetch) githubOptions.fetch = input.fetch;
	const github = createGithubAppTransport(githubOptions);
	const response = await github.appRequest("/app");
	if (
		!response.ok ||
		(await appIdFromResponse(response)) !== Number(input.appId)
	)
		throw new Error("App key verification failed");
	await mkdir(input.home, { recursive: true, mode: 0o700 });
	const home = await realpath(input.home);
	if (await checkoutRoot(home))
		throw new Error("credential home is inside the repository");
	const root = join(home, "ci", "github-credentials");
	const versions = join(root, "versions");
	await privateDirectory(join(home, "ci"));
	await privateDirectory(root);
	await privateDirectory(versions);
	const canonicalRoot = await realpath(root);
	if (!inside(home, canonicalRoot) || (await checkoutRoot(canonicalRoot)))
		throw new Error("credential directory is outside the private home");
	const version = `${input.appId}-${randomUUID()}`;
	const directory = join(versions, version);
	const temporary = join(root, `.current-${randomUUID()}`);
	let saved = false;
	try {
		await mkdir(directory, { mode: 0o700 });
		await writeFile(join(directory, "private-key.pem"), pem, {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(join(directory, "webhook-secret"), secret, {
			mode: 0o600,
			flag: "wx",
		});
		await writeFile(temporary, `${version}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, join(root, "current"));
		saved = true;
	} finally {
		await rm(temporary, { force: true });
		if (!saved) await rm(directory, { recursive: true, force: true });
	}
}

/** Return only paths and App ID. A running relay keeps its old version until restart. */
export async function storedGithubKey(home: string): Promise<
	| {
			appId: string;
			keyFile: string;
			webhookSecretFile: string;
	  }
	| undefined
> {
	const root = join(resolve(home), "ci", "github-credentials");
	try {
		await lstat(root);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
	await checkPrivateDirectory(join(resolve(home), "ci"));
	await checkPrivateDirectory(root);
	await checkPrivateDirectory(join(root, "versions"));
	const version = (await fileText(join(root, "current"), 128)).trim();
	const match = Version.exec(version);
	if (!match || !Number.isSafeInteger(Number(match[1])))
		throw new Error("invalid credential version");
	const directory = join(root, "versions", version);
	const entry = await lstat(directory);
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		(entry.mode & 0o077) !== 0
	)
		throw new Error("invalid credential directory");
	const keyFile = join(directory, "private-key.pem");
	const webhookSecretFile = join(directory, "webhook-secret");
	for (const path of [keyFile, webhookSecretFile]) {
		const file = await lstat(path);
		if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
			throw new Error("invalid credential permissions");
	}
	return { appId: match[1] ?? "", keyFile, webhookSecretFile };
}

/** Explicit environment configuration wins as a unit; never mix two Apps. */
export async function githubKeyEnvironment(
	env: NodeJS.ProcessEnv,
	home: string,
): Promise<NodeJS.ProcessEnv> {
	if (
		env.HOBO_CI_GITHUB_APP_ID ||
		env.HOBO_CI_GITHUB_APP_ID_FILE ||
		env.HOBO_CI_GITHUB_APP_KEY_FILE ||
		env.HOBO_CI_GITHUB_APP_PRIVATE_KEY ||
		env.HOBO_CI_GITHUB_APP_PRIVATE_KEY_FILE ||
		env.HOBO_CI_WEBHOOK_SECRET ||
		env.HOBO_CI_WEBHOOK_SECRET_FILE
	)
		return env;
	const stored = await storedGithubKey(home);
	if (!stored) return env;
	return {
		...env,
		HOBO_CI_GITHUB_APP_ID: stored.appId,
		HOBO_CI_GITHUB_APP_KEY_FILE: stored.keyFile,
		HOBO_CI_WEBHOOK_SECRET_FILE: stored.webhookSecretFile,
	};
}
