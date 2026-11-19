import { afterAll, beforeAll } from "vitest";
import { LOCAL_REPO_ENV } from "../../../scripts/lib/pins-git-core.js";

export function isolateTurboEnv(): void {
	const inherited = Object.entries(process.env).filter(
		([name]) =>
			name.startsWith("TURBO_") ||
			LOCAL_REPO_ENV.some((repoName) => repoName === name),
	);
	beforeAll(() => {
		for (const [name] of inherited) delete process.env[name];
	});
	afterAll(() => {
		for (const [name, value] of inherited) process.env[name] = value;
	});
}
