import { readFileSync } from "node:fs";

export function relayInstallAssets() {
	return {
		workflow: readFileSync(
			new URL("../templates/hobo-ci-host.yml", import.meta.url),
			"utf8",
		),
		bootstrap: readFileSync(
			new URL("../src/bootstrap.ts", import.meta.url),
			"utf8",
		),
	};
}
