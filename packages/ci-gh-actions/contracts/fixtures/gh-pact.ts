// CLI-to-HTTP test transport. It never authenticates or contacts GitHub.
const args = process.argv.slice(2);
function option(name: string): string {
	const index = args.indexOf(name);
	const value = index < 0 ? undefined : args[index + 1];
	if (!value) throw new Error(`missing fixture CLI argument ${name}`);
	return value;
}
async function main() {
	const origin = new URL(process.env.HOBO_PACT_GITHUB_ORIGIN ?? "");
	if (
		origin.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(origin.hostname)
	)
		throw new Error("fixture requires loopback Pact server");
	if (args[0] !== "api" || option("--hostname") !== "github.com")
		throw new Error("unexpected GitHub CLI contract");
	const path = args.find((value) => value.startsWith("/repos/"));
	if (!path || path.includes("..")) throw new Error("unexpected fixture path");
	const method = option("--method");
	const headers = new Headers();
	for (let i = 0; i < args.length; i++)
		if (args[i] === "-H") {
			const entry = args[i + 1] ?? "";
			const colon = entry.indexOf(":");
			if (colon < 1) throw new Error("invalid fixture header");
			headers.set(entry.slice(0, colon), entry.slice(colon + 1).trim());
		}
	let body = "";
	for await (const chunk of process.stdin) body += String(chunk);
	if (body) headers.set("Content-Type", "application/json");
	const request: RequestInit = {
		method,
		headers,
		redirect: "error",
	};
	if (body) request.body = body;
	const response = await fetch(`${origin.origin}${path}`, request);
	if (!response.ok) {
		process.stderr.write(`gh: fixture API failure (HTTP ${response.status})`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(await response.text());
}
main().catch(() => {
	process.stderr.write("fixture transport failed");
	process.exitCode = 1;
});
