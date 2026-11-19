import type { CommandResult } from "../types/envelope.js";

export function stubResult(verb: string): CommandResult {
	return {
		ok: false,
		status: "not_implemented",
		code: "HOBO_CLI_STUB",
		message: `${verb} needs the composed @hobo/hobo binary after a workspace build (pnpm exec turbo run build --filter @hobo/hobo). This adapter-free shell is a stub, not the local lane.`,
		data: {},
	};
}
