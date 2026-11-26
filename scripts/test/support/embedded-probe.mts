/**
 * Child of pins-probe-signal.test.ts: a program that embeds `remoteHas` and
 * has a SIGINT handler of its own. It asks a server whose fetch never ends
 * (a held git on PATH), signals itself once that fetch has begun, and reports
 * how the question ended, how often its own handler ran, what is left in the
 * cache, and whether a SIGKILL was sent to a process group after the git
 * had ended (it waits past the 2 s escalation to see).
 *
 * argv: <repository url> <commit> ; env: PROBE_MARK, XDG_CACHE_HOME, PATH
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { remoteHas } from "../../lib/pins-git-probe.ts";

const [url = "", sha = ""] = process.argv.slice(2);
const mark = process.env.PROBE_MARK ?? "";
const kill = process.kill.bind(process);
let groupKills = 0;
// SAFETY: same parameters and result as process.kill; the wrapper only counts the call.
process.kill = ((pid: number, signal?: string | number) => {
	if (pid < 0 && signal === "SIGKILL") groupKills += 1;
	return kill(pid, signal);
}) as typeof process.kill;
let calls = 0;
process.on("SIGINT", () => {
	calls += 1;
});

const asking = remoteHas(url, sha, { allowLocal: true }).then(
	(served) => `resolved ${served}`,
	(error: Error & { code?: string }) => `rejected ${error.code ?? error.name}`,
);
while (!existsSync(mark) || readFileSync(mark, "utf8").trim() === "") {
	await new Promise((resolve) => setTimeout(resolve, 5));
}
process.kill(process.pid, "SIGINT");
const outcome = await asking;
await new Promise((resolve) => setTimeout(resolve, 2500));
const cache = join(process.env.XDG_CACHE_HOME ?? "", "siblings");
const left = existsSync(cache)
	? readdirSync(cache).filter((name) => name.startsWith(".probe-")).length
	: 0;
console.log(`outcome: ${outcome}`);
console.log(`own handler calls: ${calls}`);
console.log(`probes left: ${left}`);
console.log(`group SIGKILLs after the git ended: ${groupKills}`);
