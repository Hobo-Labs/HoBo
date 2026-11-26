// The proxied command of the real lane: what HoBo's own clients do, which is
// global `fetch` (not node:net and node:tls by hand). It records what it was
// given, then makes the requests of its plan the way an unmodified client
// does: through HTTPS_PROXY (NODE_USE_ENV_PROXY=1), trusting the run's CA from
// NODE_EXTRA_CA_CERTS.
//
//   node child-fetch.mts <out dir>
//
// <out dir>/plan.json: { wait, lingerMs, requests: [{ label, url, method,
// authorization }] }. `authorization` is "surrogate" (Bearer $VERCEL_TOKEN) or
// null (none). With `wait` the child writes <out dir>/ready and holds until
// <out dir>/go exists. With `lingerMs` it stays alive that long after its last
// request, as an agent waiting on its next step would.
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

const [out] = process.argv.slice(2);
if (out === undefined) throw new Error("usage: child-fetch.mts <out dir>");

const lines = Object.entries(process.env).map(
	([key, value]) => `${key}=${value}`,
);
writeFileSync(`${out}/env.txt`, `${lines.sort().join("\n")}\n`);
writeFileSync(`${out}/argv.json`, JSON.stringify(process.argv.slice(2)));
writeFileSync(`${out}/pid`, String(process.pid));

type Plan = {
	wait: boolean;
	lingerMs: number;
	requests: {
		label: string;
		url: string;
		method: string;
		authorization: string | null;
	}[];
};
const plan: Plan = JSON.parse(readFileSync(`${out}/plan.json`, "utf8"));

if (plan.wait) {
	writeFileSync(`${out}/ready`, "");
	const deadline = Date.now() + 60_000;
	while (!existsSync(`${out}/go`) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

for (const request of plan.requests) {
	const headers: Record<string, string> = {};
	if (request.authorization === "surrogate") {
		headers.Authorization = `Bearer ${process.env.VERCEL_TOKEN ?? ""}`;
	}
	let status = 0;
	let body = "";
	let error: string | undefined;
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers,
		});
		status = response.status;
		body = await response.text();
	} catch (caught) {
		// SAFETY: fetch rejects with an Error whose cause names the failure.
		error = String((caught as Error).cause ?? caught);
	}
	appendFileSync(
		`${out}/results.jsonl`,
		`${JSON.stringify({ label: request.label, status, body, error })}\n`,
	);
}

if (plan.lingerMs > 0) {
	await new Promise((resolve) => setTimeout(resolve, plan.lingerMs));
}
