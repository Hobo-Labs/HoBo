import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import type { PinnedGitFile } from "./pinned-git-source.js";

export async function archiveVercelSource(
	files: readonly PinnedGitFile[],
	maxBytes: number,
): Promise<Buffer | undefined> {
	const archive = pack();
	let size = 0;
	let withinLimit = true;
	const chunks: Buffer[] = [];
	const sink = new Writable({
		write(chunk: Buffer, _encoding, done) {
			size += chunk.byteLength;
			if (withinLimit && size <= maxBytes) chunks.push(Buffer.from(chunk));
			else {
				withinLimit = false;
				chunks.length = 0;
			}
			done();
		},
	});
	const completed = pipeline(archive, createGzip(), sink);
	void completed.catch(() => {});
	try {
		for (const file of files) {
			await new Promise<void>((resolve, reject) => {
				archive.entry(
					{
						name: file.path,
						mode: Number.parseInt(file.mode, 8) & 0o777,
						mtime: new Date(0),
						uid: 0,
						gid: 0,
					},
					file.content,
					(error) => (error ? reject(error) : resolve()),
				);
			});
		}
		archive.finalize();
		await completed;
	} catch (error) {
		archive.destroy();
		await completed.catch(() => {});
		throw error;
	}
	return withinLimit ? Buffer.concat(chunks, size) : undefined;
}
