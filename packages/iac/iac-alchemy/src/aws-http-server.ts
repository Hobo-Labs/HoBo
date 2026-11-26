import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Scope from "effect/Scope";
import { type AwsHttpSource, inspectAwsHttpSource } from "./aws-http-source.js";

export interface AwsHttpServer {
	readonly address: Readonly<AddressInfo>;
	close(): Promise<void>;
}

export async function startAwsHttpServer(
	source: AwsHttpSource,
	endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT,
): Promise<AwsHttpServer> {
	if (
		!inspectAwsHttpSource(source) ||
		!endpoint ||
		endpoint.length > 512 ||
		/[\s\p{Cc}]/u.test(endpoint)
	)
		throw new Error("invalid AWS HTTP endpoint or source");
	let address: URL;
	try {
		address = new URL(`http://${endpoint}`);
	} catch {
		throw new Error("invalid AWS HTTP endpoint");
	}
	if (
		!address.hostname ||
		!address.port ||
		address.username ||
		address.password ||
		address.pathname !== "/" ||
		address.search ||
		address.hash
	)
		throw new Error("invalid AWS HTTP endpoint");
	const port = Number(address.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("invalid AWS HTTP port");
	const hostname = address.hostname.startsWith("[")
		? address.hostname.slice(1, -1)
		: address.hostname;
	const scope = Scope.makeUnsafe();
	let server: Server | undefined;
	try {
		const listener = await Effect.runPromise(
			NodeHttpServer.makeHandler(
				HttpEffect.fromWebHandler((request) => source.fetch(request)),
				{ scope },
			),
		);
		server = createServer({ maxHeaderSize: 16_384 }, listener);
		server.maxHeadersCount = 128;
		server.headersTimeout = 10_000;
		server.requestTimeout = 15_000;
		server.timeout = 15_000;
		const active = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				active.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				active.off("error", onError);
				resolve();
			};
			active.once("error", onError);
			active.once("listening", onListening);
			active.listen(port, hostname);
		});
		const boundAddress = active.address();
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Node represents TCP and Unix listener addresses as distinct union variants.
		if (!boundAddress || typeof boundAddress === "string")
			throw new Error("AWS HTTP listener has no TCP address");
		const addressInfo = Object.freeze({
			address: boundAddress.address,
			family: boundAddress.family,
			port: boundAddress.port,
		});
		let closed: Promise<void> | undefined;
		return Object.freeze({
			address: addressInfo,
			close() {
				closed ??= new Promise<void>((resolve, reject) => {
					active.close((error) => {
						if (error) reject(error);
						else resolve();
					});
				}).finally(() =>
					Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
				);
				return closed;
			},
		});
	} catch (error) {
		server?.close();
		await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
		throw error;
	}
}
