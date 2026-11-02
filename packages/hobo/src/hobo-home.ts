import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonString } from "./json.js";

export function defaultHoboHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.HOBO_HOME;
	if (isJsonString(fromEnv) && fromEnv.length > 0) {
		return fromEnv;
	}
	return join(homedir(), ".hobo");
}
