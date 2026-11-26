/**
 * Attempt Convex self-host via Clawdship Docker (OpenPouch competitor).
 * One-shot only. Dockerfile FROM official Convex OCI — host must have enough RAM.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { provisionClawdship } from "./clawdship.mts";
import { AnonContainerHostError } from "./types.mts";

export const CONVEX_DEFAULT_OCI =
	"ghcr.io/get-convex/convex-backend:latest" as const;

export type ConvexClawdshipResult = {
	readonly ok: true;
	readonly backendUrl: string;
	readonly adminKey: string;
	readonly claimUrl?: string;
	readonly mocked: boolean;
	readonly host: "clawdship";
};

export async function provisionConvexBackendViaClawdship(input: {
	readonly image?: string;
	readonly mock?: boolean;
	readonly adminKey?: string;
	readonly port?: number;
}): Promise<ConvexClawdshipResult> {
	const image = input.image?.trim() || CONVEX_DEFAULT_OCI;
	const port = input.port ?? 3210;
	const adminKey =
		input.adminKey?.trim() ||
		`hobo-temp-${randomBytes(16).toString("hex")}`;

	if (input.mock) {
		return {
			ok: true,
			backendUrl: "https://hobo-convex-mock.clawdship.dev",
			adminKey,
			mocked: true,
			host: "clawdship",
		};
	}

	const staging = await mkdtemp(path.join(tmpdir(), "hobo-convex-claw-"));
	try {
		const dockerfile = `FROM ${image}
EXPOSE ${port}
`;
		await writeFile(path.join(staging, "Dockerfile"), dockerfile);
		const deployed = await provisionClawdship({
			workDir: staging,
			projectHint: `hobo-convex-${randomBytes(3).toString("hex")}`,
			port,
			type: "docker",
			env: {
				CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
			},
		});
		return {
			ok: true,
			backendUrl: deployed.url.replace(/\/$/u, ""),
			adminKey,
			claimUrl: deployed.claimUrl,
			mocked: false,
			host: "clawdship",
		};
	} catch (error) {
		if (error instanceof AnonContainerHostError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new AnonContainerHostError("clawdship", message);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
