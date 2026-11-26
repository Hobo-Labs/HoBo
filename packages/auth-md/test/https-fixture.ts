import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer, request, type ServerOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real HTTPS fixture: a fresh private CA certificate trusted only by its injected transport. */
export async function createSelfHostedHttpsFixture(handler: RequestListener) {
	const directory = await mkdtemp(join(tmpdir(), "authmd-https-"));
	const keyPath = join(directory, "server.key");
	const certificatePath = join(directory, "server.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
			"-keyout",
			keyPath,
			"-out",
			certificatePath,
		],
		{ stdio: "ignore" },
	);
	const certificate = await readFile(certificatePath);
	const tls: ServerOptions = {
		key: await readFile(keyPath),
		cert: certificate,
	};
	const server = createServer(tls, handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || !(address instanceof Object))
		throw new Error("TLS fixture did not bind");
	const origin = `https://127.0.0.1:${address.port}`;
	const fetchImpl: typeof fetch = async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const headers = Object.fromEntries(new Headers(init.headers));
		return new Promise<Response>((resolve, reject) => {
			const req = request(
				url,
				{
					method: init.method ?? "GET",
					headers,
					ca: certificate,
					rejectUnauthorized: true,
					signal: init.signal ?? undefined,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					res.on("error", reject);
					res.on("end", () => {
						const responseHeaders = new Headers();
						for (const [key, value] of Object.entries(res.headers)) {
							if (Array.isArray(value))
								value.forEach((item) => {
									responseHeaders.append(key, item);
								});
							else if (value !== undefined) responseHeaders.set(key, value);
						}
						const status = res.statusCode ?? 500;
						resolve(
							new Response(
								status === 204 || status === 304 ? null : Buffer.concat(chunks),
								{ status, headers: responseHeaders },
							),
						);
					});
				},
			);
			req.on("error", reject);
			if (init.body !== undefined && init.body !== null)
				req.write(String(init.body));
			req.end();
		});
	};
	return {
		origin,
		port: { fetchImpl },
		fetchImpl,
		certificatePath,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
