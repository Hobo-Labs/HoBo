import { resolveHoboHome } from "@hobo/core/hobo-home";

/**
 * `@hobo/core/hobo-home`'s rule (`HOBO_HOME`, else `.hobo` under HOME, else
 * under the account's home; never a temp directory), under the name this
 * package exports it as.
 */
export function defaultHoboHome(env: NodeJS.ProcessEnv = process.env): string {
	return resolveHoboHome(env);
}
