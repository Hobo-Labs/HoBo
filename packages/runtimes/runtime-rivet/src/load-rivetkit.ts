import { RIVETKIT_PIN } from "./upstream-pin.js";

export type RivetkitModule = typeof import("rivetkit");
export type RivetkitClientModule = typeof import("rivetkit/client");

export function assertRivetEngineSupported(
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") return;
	throw new Error(
		`RivetKit ${RIVETKIT_PIN.version} has no Windows engine binary; local engine execution is unsupported on win32`,
	);
}

export async function loadRivetkit(): Promise<RivetkitModule> {
	assertRivetEngineSupported();
	const loaded = await import("rivetkit");
	if (
		!(loaded.actor instanceof Function) ||
		!(loaded.setup instanceof Function)
	) {
		throw new Error("rivetkit module missing actor/setup");
	}
	return loaded;
}

export async function loadRivetkitClient(): Promise<RivetkitClientModule> {
	const loaded = await import("rivetkit/client");
	if (!(loaded.createClient instanceof Function)) {
		throw new Error("rivetkit/client missing createClient");
	}
	return loaded;
}
