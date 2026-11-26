import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	type DaggerCheckRunOptions,
	DaggerCheckTimeoutError,
	daggerCheckArgs,
	parseDaggerCheckConfig,
	runDaggerChecks,
} from "./checks.js";

async function readConfig(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const limit = 64 * 1024;
		const details = await file.stat();
		if (!details.isFile() || details.size > limit)
			throw new Error("Dagger check config must be a file of at most 64 KiB");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > limit) throw new Error("Dagger check config exceeds 64 KiB");
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		await file.close();
	}
}

export async function runDaggerCheckCli(
	args: string[],
	options: DaggerCheckRunOptions & { write?: (text: string) => void } = {},
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", default: ".hobo/dagger.json" },
			plan: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
			dagger: { type: "string" },
		},
	});
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	if (values.help) {
		write(
			"Usage: checks [--config .hobo/dagger.json] [--dagger path] [--plan]\n",
		);
		return 0;
	}
	const initialDirectory = (options.env ?? process.env).INIT_CWD;
	if (!options.cwd && initialDirectory && !isAbsolute(initialDirectory))
		throw new Error("INIT_CWD must be an absolute directory");
	const cwd = resolve(options.cwd ?? initialDirectory ?? process.cwd());
	const config = parseDaggerCheckConfig(
		await readConfig(resolve(cwd, values.config)),
	);
	const executable = values.dagger ?? options.executable ?? "dagger";
	if (values.plan) {
		write(
			`${JSON.stringify({ executable, args: daggerCheckArgs(config, cwd) }, null, 2)}\n`,
		);
		return 0;
	}
	return runDaggerChecks(config, { ...options, cwd, executable });
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const controller = new AbortController();
	let interrupted = 0;
	const interrupt = () => {
		interrupted = 130;
		controller.abort();
	};
	const terminate = () => {
		interrupted = 143;
		controller.abort();
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		process.exitCode = await runDaggerCheckCli(process.argv.slice(2), {
			signal: controller.signal,
		});
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Dagger checks failed"}\n`,
		);
		process.exitCode =
			interrupted || (error instanceof DaggerCheckTimeoutError ? 124 : 1);
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
	}
}
