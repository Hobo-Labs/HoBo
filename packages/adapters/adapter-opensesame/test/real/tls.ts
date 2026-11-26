/**
 * A recording TLS server standing in for api.vercel.com, on 127.0.0.1, with a
 * certificate minted here with `openssl`: a CA, and a leaf for api.vercel.com
 * signed by it. It keeps every request it receives, header values included, so
 * a test can say what did and did not cross the last hop. The plugin's test
 * build is aimed at it with OPENSESAME_SURROGATE_TEST_UPSTREAM.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const UPSTREAM_HOST = "api.vercel.com";
export const UPSTREAM_BODY = '{"id":"prj_dummy","name":"dummy"}';

export type Pki = Readonly<{
	caPem: string;
	leafKey: string;
	leafPem: string;
}>;

function openssl(dir: string, args: readonly string[]): void {
	execFileSync("openssl", [...args], { cwd: dir, stdio: "pipe" });
}

/** Mint a throwaway CA and a server certificate for api.vercel.com in `dir`. */
export function mintPki(dir: string): Pki {
	openssl(dir, [
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"2",
		"-subj",
		"/CN=hobo adapter-opensesame test ca",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign",
	]);
	openssl(dir, [
		"req",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		"leaf.key",
		"-out",
		"leaf.csr",
		"-subj",
		`/CN=${UPSTREAM_HOST}`,
	]);
	writeFileSync(
		join(dir, "leaf.ext"),
		`subjectAltName=DNS:${UPSTREAM_HOST}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`,
	);
	openssl(dir, [
		"x509",
		"-req",
		"-in",
		"leaf.csr",
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-CAcreateserial",
		"-out",
		"leaf.pem",
		"-days",
		"2",
		"-extfile",
		"leaf.ext",
	]);
	return {
		caPem: join(dir, "ca.pem"),
		leafKey: join(dir, "leaf.key"),
		leafPem: join(dir, "leaf.pem"),
	};
}

/** What the upstream saw, one entry per request. */
export type Hit = Readonly<{
	method: string;
	path: string;
	authorization: string | undefined;
	/** Every header value, so "never crossed the wire" can be said of all of them. */
	allValues: readonly string[];
}>;

export type Upstream = Readonly<{
	port: number;
	hits(): readonly Hit[];
	close(): Promise<void>;
}>;

export async function startUpstream(pki: Pki): Promise<Upstream> {
	const hits: Hit[] = [];
	const server: Server = createServer(
		{ key: readFileSync(pki.leafKey), cert: readFileSync(pki.leafPem) },
		(request, response) => {
			hits.push({
				method: request.method ?? "",
				path: request.url ?? "",
				authorization: request.headers.authorization,
				allValues: Object.values(request.headers).flatMap((value) =>
					Array.isArray(value) ? value : [value ?? ""],
				),
			});
			response.setHeader("content-type", "application/json");
			response.end(UPSTREAM_BODY);
		},
	);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	// SAFETY: a TCP server listening on a port has an AddressInfo address.
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		hits: () => [...hits],
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
