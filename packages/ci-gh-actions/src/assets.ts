import { readFileSync } from "node:fs";

/** The same reviewed bootstrap source is installed in customer repositories. */
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
