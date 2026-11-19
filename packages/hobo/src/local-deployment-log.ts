import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

const MAX_LOG_BYTES = 1_048_576;
const READ_SIZE = 65_536;

type LogCursor = Readonly<{ device: number; inode: number; offset: number }>;

export function localDeploymentLogPath(projectDir: string): string {
	return join(resolve(projectDir), ".hobo", "local-deployment.log");
}

async function openLog(projectDir: string) {
	try {
		return await open(localDeploymentLogPath(projectDir), "r");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

export async function readLocalDeploymentLog(projectDir: string, limit = 200) {
	const file = await openLog(projectDir);
	if (!file)
		return {
			exists: false,
			lines: [],
			truncated: false,
			partial: false,
			cursor: null,
		};
	try {
		const { size, dev, ino } = await file.stat();
		const offset = Math.max(0, size - MAX_LOG_BYTES);
		const buffer = Buffer.alloc(size - offset);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				offset + bytesRead,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		const bytes = buffer.subarray(0, bytesRead);
		const firstNewline = offset > 0 ? bytes.indexOf(10) : -1;
		const start = firstNewline >= 0 ? firstNewline + 1 : 0;
		const content = bytes.subarray(start);
		const partial = content.length > 0 && content.at(-1) !== 10;
		const allLines = content.toString("utf8").split(/\r?\n/u);
		if (allLines.at(-1) === "") allLines.pop();
		const lastNewline = bytes.lastIndexOf(10);
		return {
			exists: true,
			lines: allLines.slice(-limit),
			truncated: offset > 0 || allLines.length > limit,
			partial,
			cursor: {
				device: dev,
				inode: ino,
				offset: offset + (lastNewline >= 0 ? lastNewline + 1 : start),
			},
		};
	} finally {
		await file.close();
	}
}

export async function followLocalDeploymentLog(options: {
	readonly projectDir: string;
	readonly cursor: LogCursor | null;
	readonly signal: AbortSignal;
	readonly onLine: (line: string) => void;
	readonly onGap?: (reason: "rotated" | "truncated") => void;
	readonly pollIntervalMs?: number;
}) {
	let cursor = options.cursor;
	let decoder = new StringDecoder("utf8");
	let partial = "";
	while (!options.signal.aborted) {
		const file = await openLog(options.projectDir);
		if (file) {
			try {
				const { dev, ino, size } = await file.stat();
				if (
					!cursor ||
					cursor.device !== dev ||
					cursor.inode !== ino ||
					cursor.offset > size
				) {
					const trailing = partial + decoder.end();
					if (trailing) options.onLine(trailing);
					if (cursor) {
						options.onGap?.(
							cursor.device !== dev || cursor.inode !== ino
								? "rotated"
								: "truncated",
						);
					}
					partial = "";
					decoder = new StringDecoder("utf8");
					cursor = { device: dev, inode: ino, offset: 0 };
				}
				while (cursor.offset < size && !options.signal.aborted) {
					const bytes = Buffer.alloc(Math.min(READ_SIZE, size - cursor.offset));
					const readResult = await file.read(
						bytes,
						0,
						bytes.length,
						cursor.offset,
					);
					const bytesRead: number = readResult.bytesRead;
					if (bytesRead === 0) break;
					cursor = { ...cursor, offset: cursor.offset + bytesRead };
					const lines = (
						partial + decoder.write(bytes.subarray(0, bytesRead))
					).split("\n");
					partial = lines.pop() ?? "";
					for (const line of lines)
						options.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
					if (partial.length > MAX_LOG_BYTES) {
						options.onLine(partial);
						partial = "";
					}
				}
			} finally {
				await file.close();
			}
		}
		try {
			await delay(options.pollIntervalMs ?? 250, undefined, {
				signal: options.signal,
			});
		} catch (error) {
			if (!options.signal.aborted) throw error;
		}
	}
	const trailing = partial + decoder.end();
	if (trailing) options.onLine(trailing);
}
