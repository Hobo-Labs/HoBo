// hobo-code's entry for tests that hand off a Station session. As
// `_station-agent` it runs the resident SSH-agent proxy the real entry runs
// (`runResidentSshAgentProxy`), without loading the whole CLI first: the
// launcher of a proxy waits 3 s for its socket, and a cold start of the whole
// CLI can take longer on a loaded machine. Any other argv runs the real entry.
//   node hobo-code-entry.mjs <hobo-code argv...>
const [, , role, payload] = process.argv;
if (role === "_station-agent") {
	const { runResidentSshAgentProxy } = await import(
		"../../dist/ssh-agent-proxy.js"
	);
	process.exitCode = await runResidentSshAgentProxy(payload ?? "");
} else {
	await import("../../dist/bin/hobo-code.js");
}
