import { z } from "zod";
import type { GithubTransport } from "./github.js";

const Runner = z.object({
	id: z.number().int().positive(),
	status: z.enum(["online", "offline"]),
	busy: z.boolean(),
});

export type GithubRunnerPresence = Readonly<{
	status: "online" | "offline";
	busy: boolean;
}>;

export async function fetchGithubRunnerPresence(
	github: GithubTransport,
	installationId: number,
	repository: string,
	runnerId: number,
): Promise<GithubRunnerPresence | undefined> {
	if (!Number.isInteger(runnerId) || runnerId <= 0) return undefined;
	try {
		const response = await github.request(
			installationId,
			`/repos/${repository}/actions/runners/${runnerId}`,
		);
		if (!response.ok) return undefined;
		const parsed = Runner.parse(await response.json());
		return { status: parsed.status, busy: parsed.busy };
	} catch {
		return undefined;
	}
}
