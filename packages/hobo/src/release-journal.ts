/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: checkpoints read from disk are untrusted and are validated before they become ReleaseCheckpoint values. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	type FileHandle,
	mkdir,
	open,
	readdir,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ReleaseCheckpoint,
	ReleaseJournal,
} from "./release-controller.js";

function valid(value: unknown): value is ReleaseCheckpoint {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	if (
		!("deploymentId" in value) ||
		!("previousDeploymentId" in value) ||
		!("commit" in value) ||
		!("state" in value)
	)
		return false;
	return (
		typeof value.deploymentId === "string" &&
		/^dpl_[A-Za-z0-9]+$/u.test(value.deploymentId) &&
		typeof value.previousDeploymentId === "string" &&
		/^dpl_[A-Za-z0-9]+$/u.test(value.previousDeploymentId) &&
		value.deploymentId !== value.previousDeploymentId &&
		typeof value.commit === "string" &&
		/^[0-9a-f]{40}$/u.test(value.commit) &&
		(value.state === "reserved" ||
			value.state === "verified" ||
			value.state === "rolled-back")
	);
}

function sameRelease(a: ReleaseCheckpoint, b: ReleaseCheckpoint): boolean {
	return (
		a.deploymentId === b.deploymentId &&
		a.previousDeploymentId === b.previousDeploymentId &&
		a.commit === b.commit
	);
}

export async function findPendingLocalRelease(
	home: string,
	projectId: string,
): Promise<ReleaseCheckpoint | undefined> {
	if (!/^prj_[A-Za-z0-9]+$/u.test(projectId))
		throw new TypeError("Invalid release project ID.");
	let entries: string[];
	try {
		entries = await readdir(join(home, "cd", "releases"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw new Error("Release checkpoints could not be listed.");
	}
	if (entries.length > 10_000)
		throw new Error("Release checkpoint history exceeds its safe limit.");
	let pending: ReleaseCheckpoint | undefined;
	for (const entry of entries) {
		const prefix = `${projectId}-`;
		if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
		const deploymentId = entry.slice(prefix.length, -5);
		if (!/^dpl_[A-Za-z0-9]+$/u.test(deploymentId))
			throw new Error("Invalid release checkpoint filename.");
		const value = await createReleaseJournal(
			home,
			projectId,
			deploymentId,
		).load();
		if (!value) throw new Error("A release checkpoint disappeared.");
		if (value.state !== "reserved") continue;
		if (pending)
			throw new Error("Multiple unfinished releases need inspection.");
		pending = value;
	}
	return pending;
}

export function createReleaseJournal(
	home: string,
	projectId: string,
	deploymentId: string,
): ReleaseJournal {
	if (
		!/^prj_[A-Za-z0-9]+$/u.test(projectId) ||
		!/^dpl_[A-Za-z0-9]+$/u.test(deploymentId)
	)
		throw new TypeError(
			"A release journal requires Vercel project and deployment IDs.",
		);
	const dir = join(home, "cd", "releases");
	const file = join(dir, `${projectId}-${deploymentId}.json`);
	async function directory(): Promise<void> {
		await mkdir(dir, { recursive: true, mode: 0o700 });
	}
	async function syncDirectory(): Promise<void> {
		const handle = await open(dirname(file), constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	async function load(): Promise<ReleaseCheckpoint | undefined> {
		let handle: FileHandle;
		try {
			handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return undefined;
			throw new Error("Release checkpoint could not be opened.");
		}
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 4096)
				throw new Error("invalid checkpoint");
			const buffer = Buffer.alloc(4097);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 4096) throw new Error("invalid checkpoint");
			const value: unknown = JSON.parse(
				buffer.subarray(0, bytesRead).toString("utf8"),
			);
			if (!valid(value) || value.deploymentId !== deploymentId)
				throw new Error("invalid checkpoint");
			return value;
		} catch {
			throw new Error("Release checkpoint is invalid.");
		} finally {
			await handle.close();
		}
	}
	async function write(
		target: string,
		value: ReleaseCheckpoint,
	): Promise<void> {
		const handle = await open(target, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	return {
		load,
		async reserve(value) {
			if (
				!valid(value) ||
				value.deploymentId !== deploymentId ||
				value.state !== "reserved"
			)
				throw new Error("Invalid release reservation.");
			await directory();
			try {
				await write(file, value);
				await syncDirectory();
				return { checkpoint: value, created: true };
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!("code" in error) ||
					error.code !== "EEXIST"
				)
					throw error;
				const existing = await load();
				if (existing === undefined)
					throw new Error("Release reservation disappeared.");
				return { checkpoint: existing, created: false };
			}
		},
		async save(value) {
			if (!valid(value) || value.deploymentId !== deploymentId)
				throw new Error("Invalid release checkpoint.");
			const existing = await load();
			if (
				existing === undefined ||
				!sameRelease(existing, value) ||
				(existing.state !== "reserved" && existing.state !== value.state)
			)
				throw new Error("Release checkpoint does not match the reservation.");
			const temp = `${file}.${randomUUID()}.tmp`;
			try {
				await write(temp, value);
				await rename(temp, file);
				await syncDirectory();
			} finally {
				await unlink(temp).catch(() => {});
			}
		},
	};
}
