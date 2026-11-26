export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | undefined;
	return () => {
		if (inFlight) return inFlight;
		const current = run();
		const tracked = current.finally(() => {
			if (inFlight === tracked) inFlight = undefined;
		});
		inFlight = tracked;
		return tracked;
	};
}
