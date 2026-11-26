import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function dockerAvailable(): boolean {
	if (process.env.HOBO_FUZZ_DOCKER === "0") return false;
	if (!existsSync("/var/run/docker.sock")) return false;
	const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
	return probe.status === 0;
}

export function schemathesisAvailable(): boolean {
	const probe = spawnSync("schemathesis", ["--version"], { stdio: "ignore" });
	return probe.status === 0;
}
