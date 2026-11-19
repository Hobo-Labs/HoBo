
export type RivetkitModule = typeof import("rivetkit");
export type RivetkitClientModule = typeof import("rivetkit/client");

export async function loadRivetkit(): Promise<RivetkitModule> {
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
