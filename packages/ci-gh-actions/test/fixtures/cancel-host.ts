import { runHostProcess, runnerEnvironment } from "../../src/bootstrap.ts";

try {
	await runHostProcess(
		process.execPath,
		[
			"-e",
			'process.on("SIGTERM",()=>{process.stdout.write("STOPPED");process.exit(0)});process.stdout.write("READY");setInterval(()=>{},1000)',
		],
		process.cwd(),
		runnerEnvironment(process.env),
		30000,
	);
} catch {
	process.exitCode = 1;
}
