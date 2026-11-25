import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	HOSTED_PLAYWRIGHT_BROWSERS_ROOT,
	installHostedPlaywrightHeadlessShell,
} from "../lib/playwright-headless-shell-install.mts";

function browsersRoot(): string {
	const fromEnv = process.env.HOBO_CI_PLAYWRIGHT_BROWSERS_ROOT?.trim();
	return fromEnv && fromEnv.length > 0
		? fromEnv
		: HOSTED_PLAYWRIGHT_BROWSERS_ROOT;
}

function main(): void {
	const root = browsersRoot();
	const installDir = installHostedPlaywrightHeadlessShell({
		browsersRoot: root,
	});
	process.stderr.write(`playwright headless-shell ready at ${installDir}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`::error::${message}`);
		process.exitCode = 1;
	}
}
