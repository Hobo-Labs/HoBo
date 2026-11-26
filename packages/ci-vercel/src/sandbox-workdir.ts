/** A fresh Sandbox need not contain the upload directory. Create it before
 * writing files, without assuming the default working directory exists. */
export async function ensureSandboxWorkdir(session: {
	runCommand(options: {
		cmd: string;
		args: string[];
		cwd: string;
		detached: false;
	}): Promise<{ exitCode: number }>;
}): Promise<void> {
	const result = await session.runCommand({
		cmd: "mkdir",
		args: ["-p", "-m", "700", "/vercel/sandbox"],
		cwd: "/",
		detached: false,
	});
	if (result.exitCode !== 0) throw new Error("sandbox workdir creation failed");
}
