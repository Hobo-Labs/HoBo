import { runAiBdd, stopRunningAiBdd } from "../../src/ai-bdd-process.js";

const [signalArg, graceArg, commandArg, nextArg] = process.argv.slice(2);
const signal = signalArg === "SIGINT" ? "SIGINT" : "SIGTERM";
const graceMs = Number(graceArg);
// SAFETY: the test that spawns this passes two JSON arrays of strings.
const command = JSON.parse(commandArg ?? "[]") as string[];
// SAFETY: as above.
const next = JSON.parse(nextArg ?? "[]") as string[];

let ready = (): void => undefined;
const up = new Promise<void>((done) => {
	ready = done;
});
const spec = {
	cwd: process.cwd(),
	env: process.env,
	timeoutMs: 120_000,
	graceMs,
	relay: (chunk: Buffer) => {
		if (chunk.toString("utf8").includes("up")) ready();
	},
};
const first = runAiBdd({ ...spec, command }, []);
await up;
const started = Date.now();
await stopRunningAiBdd(signal);
const stopMs = Date.now() - started;
const stopped = await first;
const after = await runAiBdd({ ...spec, command: next }, []);
process.stdout.write(
	`${JSON.stringify({ stopMs, tail: stopped.tail, afterStatus: after.status, afterUnstartable: after.unstartable })}\n`,
);
