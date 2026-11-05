export function createTickTrigger(options: {
	run: () => Promise<void>;
	onError: (error: Error) => void;
}) {
	let inFlight = false;
	let followUp = false;

	const trigger = (): void => {
		if (inFlight) {
			followUp = true;
			return;
		}
		inFlight = true;
		void (async () => {
			try {
				await options.run();
			} catch (error) {
				options.onError(error instanceof Error ? error : new Error("unknown"));
			} finally {
				inFlight = false;
				if (followUp) {
					followUp = false;
					trigger();
				}
			}
		})();
	};

	return { trigger };
}
