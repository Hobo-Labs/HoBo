export function agentPressAllowed(
	confirmMessage: string | undefined,
	personApproved: boolean,
): boolean {
	if (confirmMessage === undefined || confirmMessage === "") return true;
	return personApproved;
}

export function readAgentConfirm(
	target: EventTarget | null,
): string | undefined {
	if (!(target instanceof Element)) return undefined;
	const host = target.closest("[data-agent-confirm]");
	if (host === null) return undefined;
	const message = host.getAttribute("data-agent-confirm");
	if (message === null || message === "") return undefined;
	return message;
}
