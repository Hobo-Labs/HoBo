// Content-addressed filesystem backend: blobs live at
// `<root>/blobs/sha256/<hh>/<hex>`. A write goes to `<root>/tmp/` first, is
// fsynced, renamed into place (atomic on one filesystem), and the directory
// is fsynced, so a crash leaves either the whole blob or no blob — never a
// partial one at a digest path. Temp files are never listed or read.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { Digest } from "../ports.js";
import type { BlobBackend, BlobMeta, WriteOutcome } from "./backend.js";
import { digestHex, parseDigest } from "./digest.js";
import { errorCodeOf } from "./json.js";
import { ARTIFACT_REASON, ArtifactStoreError } from "./reasons.js";

/** The filesystem calls the backend makes; injectable so tests can fail one mid-write. */
export type FilesystemIo = Readonly<{
	mkdir: typeof fs.mkdir;
	open: typeof fs.open;
	rename: typeof fs.rename;
	rm: typeof fs.rm;
	readFile: typeof fs.readFile;
	stat: typeof fs.stat;
	readdir: typeof fs.readdir;
}>;

export const NODE_FILESYSTEM_IO: FilesystemIo = Object.freeze({
	mkdir: fs.mkdir,
	open: fs.open,
	rename: fs.rename,
	rm: fs.rm,
	readFile: fs.readFile,
	stat: fs.stat,
	readdir: fs.readdir,
});

function errorCode<E>(error: E): string {
	const code = errorCodeOf(error);
	return /^E[A-Z]+$/.test(code) ? code : "";
}

function unavailable<E>(operation: string, error: E): ArtifactStoreError {
	const code = errorCode(error) || "EIO";
	return new ArtifactStoreError(
		ARTIFACT_REASON.backendUnavailable,
		`filesystem ${operation} failed (${code})`,
		"Check that the artifact root exists, is writable by the HoBo process, and has free space; then retry the operation (it is idempotent).",
	);
}

export function createFilesystemBackend(
	root: string,
	io: FilesystemIo = NODE_FILESYSTEM_IO,
): BlobBackend {
	const blobsDir = join(root, "blobs", "sha256");
	const tmpDir = join(root, "tmp");
	let sequence = 0;

	const pathOf = (digest: Digest) => {
		const hex = digestHex(digest);
		return {
			dir: join(blobsDir, hex.slice(0, 2)),
			file: join(blobsDir, hex.slice(0, 2), hex),
		};
	};

	async function fsyncDirectory(dir: string): Promise<void> {
		// Directory fsync makes the rename durable on POSIX. Platforms that
		// cannot open a directory (Windows) refuse it; the rename is still atomic.
		let handle: fs.FileHandle | undefined;
		try {
			handle = await io.open(dir, "r");
			await handle.sync();
		} catch (error) {
			const code = errorCode(error);
			if (
				code !== "EISDIR" &&
				code !== "EPERM" &&
				code !== "EACCES" &&
				code !== "EINVAL"
			)
				throw error;
		} finally {
			await handle?.close();
		}
	}

	async function present(file: string): Promise<boolean> {
		try {
			const info = await io.stat(file);
			return info.isFile();
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw unavailable("stat", error);
		}
	}

	return {
		name: "filesystem",
		maxBlobBytes: Number.MAX_SAFE_INTEGER,
		async write(
			digest: Digest,
			bytes: Uint8Array,
			_meta: BlobMeta,
			options: Readonly<{ replace: boolean }>,
		): Promise<WriteOutcome> {
			const target = pathOf(digest);
			if (!options.replace && (await present(target.file))) return "exists";
			sequence += 1;
			const temp = join(
				tmpDir,
				`${digestHex(digest)}.${process.pid}.${sequence}.partial`,
			);
			try {
				await io.mkdir(tmpDir, { recursive: true });
				await io.mkdir(target.dir, { recursive: true });
				const handle = await io.open(temp, "wx");
				try {
					await handle.writeFile(bytes);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await io.rename(temp, target.file);
				await fsyncDirectory(target.dir);
				return "created";
			} catch (error) {
				await io.rm(temp, { force: true }).catch(() => undefined);
				if (error instanceof ArtifactStoreError) throw error;
				throw unavailable("write", error);
			}
		},
		async read(digest: Digest) {
			try {
				return new Uint8Array(await io.readFile(pathOf(digest).file));
			} catch (error) {
				if (errorCode(error) === "ENOENT") return undefined;
				throw unavailable("read", error);
			}
		},
		async exists(digest: Digest) {
			return present(pathOf(digest).file);
		},
		async *keys(signal: AbortSignal) {
			let shards: string[];
			try {
				shards = (await io.readdir(blobsDir)).map(String).sort();
			} catch (error) {
				if (errorCode(error) === "ENOENT") return;
				throw unavailable("list", error);
			}
			for (const shard of shards) {
				if (!/^[0-9a-f]{2}$/.test(shard)) continue;
				let names: string[];
				try {
					names = (await io.readdir(join(blobsDir, shard))).map(String).sort();
				} catch (error) {
					if (errorCode(error) === "ENOENT") continue;
					throw unavailable("list", error);
				}
				for (const name of names) {
					if (signal.aborted) return;
					const digest = parseDigest(`sha256:${name}`);
					if (digest !== undefined && name.startsWith(shard)) yield digest;
				}
			}
		},
		async remove(digest: Digest) {
			try {
				await io.rm(pathOf(digest).file, { force: true });
			} catch (error) {
				throw unavailable("delete", error);
			}
		},
	};
}
