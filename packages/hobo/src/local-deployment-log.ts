import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_LOG_BYTES = 1_048_576;

export function localDeploymentLogPath(projectDir: string): string {
	return join(resolve(projectDir), ".hobo", "local-deployment.log");
}

export async function readLocalDeploymentLog(projectDir: string, limit = 200) {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(localDeploymentLogPath(projectDir), "r");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { exists: false, lines: [], truncated: false };
		}
		throw error;
	}
	try {
		const { size } = await file.stat();
		const offset = Math.max(0, size - MAX_LOG_BYTES);
		const buffer = Buffer.alloc(size - offset);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
		if (offset > 0) {
			const newline = text.indexOf("\n");
			if (newline >= 0) text = text.slice(newline + 1);
		}
		const allLines = text.split(/\r?\n/u);
		if (allLines.at(-1) === "") allLines.pop();
		return {
			exists: true,
			lines: allLines.slice(-limit),
			truncated: offset > 0 || allLines.length > limit,
		};
	} finally {
		await file.close();
	}
}
