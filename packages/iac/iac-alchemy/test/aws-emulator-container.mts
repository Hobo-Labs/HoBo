import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function prepareAwsEmulatorImage(
	scratch: string,
	executable: string,
	baseImage: string,
): string {
	const context = join(scratch, "docker-context");
	mkdirSync(context);
	copyFileSync(executable, join(context, "aws-emulator"));
	writeFileSync(
		join(context, "Dockerfile"),
		`FROM ${baseImage}\nCOPY --chmod=0755 aws-emulator /usr/local/bin/aws-emulator\n`,
	);
	return context;
}

export function awsEmulatorRunArgs(name: string): string[] {
	return [
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--tmpfs",
		"/root:rw,noexec,nosuid,size=128m",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=128m",
		"--publish",
		"127.0.0.1::9297",
		name,
		"/usr/local/bin/aws-emulator",
		"--bind",
		"0.0.0.0",
		"--port",
		"9297",
		"--auth",
		"off",
		"--telemetry",
		"off",
		"--idle-timeout",
		"900",
	];
}
