/**
 * Validate live anon OpenSaaS Temporary endpoints (client + server + db).
 * Usage:
 *   HOBO_OPENSAAS_CLIENT_URL=... HOBO_OPENSAAS_SERVER_URL=... \
 *   HOBO_OPENSAAS_DATABASE_URL=... node --import tsx site/scripts/validate-opensaas-temporary-e2e.mts
 */
import { spawn } from "node:child_process";

type Check = { name: string; ok: boolean; detail: string };

async function checkHttp(name: string, url: string): Promise<Check> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		const text = await res.text();
		return {
			name,
			ok: res.ok,
			detail: `HTTP ${res.status} bytes=${text.length}`,
		};
	} catch (error) {
		return {
			name,
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

async function checkDb(databaseUrl: string): Promise<Check> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
import pg from '/tmp/neon-pg-probe/node_modules/pg/lib/index.js';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query('select 1::int as ok');
await c.end();
console.log(JSON.stringify(r.rows[0]));
`,
			],
			{
				env: { ...process.env, DATABASE_URL: databaseUrl },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr.on("data", (c) => {
			stderr += String(c);
		});
		child.on("close", (code) => {
			if (code === 0 && stdout.includes('"ok":1')) {
				resolve({ name: "neon-db", ok: true, detail: stdout.trim() });
			} else {
				resolve({
					name: "neon-db",
					ok: false,
					detail: stderr.trim() || stdout.trim() || `exit ${code}`,
				});
			}
		});
	});
}

async function main(): Promise<void> {
	const clientUrl = process.env.HOBO_OPENSAAS_CLIENT_URL?.trim();
	const serverUrl = process.env.HOBO_OPENSAAS_SERVER_URL?.trim();
	const databaseUrl = process.env.HOBO_OPENSAAS_DATABASE_URL?.trim();
	if (!clientUrl || !serverUrl || !databaseUrl) {
		console.error(
			"Need HOBO_OPENSAAS_CLIENT_URL, HOBO_OPENSAAS_SERVER_URL, HOBO_OPENSAAS_DATABASE_URL",
		);
		process.exitCode = 1;
		return;
	}

	const checks: Check[] = [];
	checks.push(await checkHttp("client", clientUrl));
	checks.push(await checkHttp("server-root", serverUrl.replace(/\/$/u, "/") ));
	checks.push(
		await checkHttp(
			"server-not-localhost",
			serverUrl.includes("127.0.0.1") || serverUrl.includes("localhost")
				? "http://invalid.invalid"
				: serverUrl,
		),
	);
	// Replace bogus check: if server is loopback, fail explicitly
	if (/127\.0\.0\.1|localhost/iu.test(serverUrl)) {
		checks.push({
			name: "server-public",
			ok: false,
			detail: "serverUrl is loopback",
		});
	} else {
		checks.push({
			name: "server-public",
			ok: true,
			detail: new URL(serverUrl).hostname,
		});
	}
	if (/workers\.dev$/iu.test(new URL(clientUrl).hostname)) {
		checks.push({
			name: "client-cf-temporary",
			ok: true,
			detail: new URL(clientUrl).hostname,
		});
	} else {
		checks.push({
			name: "client-cf-temporary",
			ok: false,
			detail: clientUrl,
		});
	}
	checks.push(await checkDb(databaseUrl));

	const ok = checks.every((c) => c.ok);
	console.log(JSON.stringify({ ok, checks }, null, 2));
	process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
