/** Return only the effective, non-secret Sandbox settings from this process. */
export function runtimeDiagnostic(options: {
	deploymentId: string | undefined;
	sandbox: { allowedDomains(): readonly string[] } | undefined;
}) {
	const { deploymentId, sandbox } = options;
	if (deploymentId && !/^dpl_[A-Za-z0-9]+$/.test(deploymentId))
		throw new Error("invalid deployment ID");
	return {
		sandboxEnabled: !!sandbox,
		allowedDomains: sandbox?.allowedDomains() ?? [],
		deploymentId: deploymentId ?? null,
	};
}
