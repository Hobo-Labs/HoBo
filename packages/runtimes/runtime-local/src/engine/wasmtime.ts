import { spawnSync } from "node:child_process";

import type {
	ComponentInstance,
	ParsedComponentDescriptor,
	WasmtimeEngine,
} from "@hobo/core";

import { ComponentHostError } from "../errors.js";

const WASMTIME_FLOOR = [46, 0, 1] as const;

export function createInProcessWasmtimeEngine(
	options: { version?: string } = {},
): WasmtimeEngine {
	const version = options.version ?? "wasmtime@46.0.1";
	return Object.freeze({
		kind: "wasmtime" as const,
		version,
		instantiate(component: ParsedComponentDescriptor): ComponentInstance {
			return {
				id: component.id,
				imports: [...component.imports],
				exports: component.exports,
			};
		},
	});
}

export function createWasmtimeCliEngine(
	options: { binPath?: string } = {},
): WasmtimeEngine {
	const binPath =
		options.binPath ?? process.env.HOBO_WASMTIME_BIN ?? "wasmtime";
	const versionOutput = spawnSync(binPath, ["--version"], { encoding: "utf8" });
	if (versionOutput.status !== 0) {
		// A binary that could not be spawned at all — the usual case, wasmtime
		// simply not installed — comes back with `status: null` and *null*
		// streams, so reading `.stderr.trim()` unguarded turns the most likely
		// failure into a TypeError instead of this named refusal. `error`
		// carries the spawn reason (ENOENT, EACCES) in exactly that case.
		throw new ComponentHostError(
			"wasmtime_version_floor",
			versionOutput.stderr?.trim() ||
				versionOutput.error?.message ||
				"wasmtime --version failed",
		);
	}

	const version = parseWasmtimeVersion(versionOutput.stdout);
	if (!meetsWasmtimeFloor(version)) {
		throw new ComponentHostError(
			"wasmtime_version_floor",
			`${version} < ${WASMTIME_FLOOR.join(".")}`,
		);
	}

	return createInProcessWasmtimeEngine({ version: `wasmtime@${version}` });
}

function parseWasmtimeVersion(output: string): string {
	const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new ComponentHostError(
			"wasmtime_version_floor",
			`unparseable version: ${output.trim()}`,
		);
	}
	return `${match[1]}.${match[2]}.${match[3]}`;
}

function meetsWasmtimeFloor(version: string): boolean {
	const parts = version.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < WASMTIME_FLOOR.length; index += 1) {
		const current = parts[index] ?? 0;
		const floor = WASMTIME_FLOOR[index] ?? 0;
		if (current > floor) return true;
		if (current < floor) return false;
	}
	return true;
}
