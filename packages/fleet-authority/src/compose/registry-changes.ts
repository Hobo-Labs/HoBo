import type { RegistryView, Subscription } from "@hobo/fleet";

export function pollRegistryChanges(
	registry: RegistryView,
	intervalMs = 1_000,
): (
	handler: (key: string, recordSequence: number) => Promise<void>,
) => Subscription {
	return (handler) => {
		const highest = new Map<string, number>();
		let stopped = false;
		let running: Promise<void> | undefined;

		const report = async (key: string, sequence: number) => {
			if (sequence <= (highest.get(key) ?? 0)) return;
			highest.set(key, sequence);
			await handler(key, sequence);
		};
		const round = async () => {
			try {
				await report("trust", Number(registry.trust().sequence));
				for (const fleet of await registry.fleets())
					await report(`fleet.${fleet.fleetId}`, fleet.revision);
				for (const member of await registry.members())
					await report(
						`member.${member.memberId}`,
						Number(member.recordSequence),
					);
			} catch {}
		};
		const tick = () => {
			if (stopped || running !== undefined) return;
			running = round().finally(() => {
				running = undefined;
			});
		};
		tick();
		const timer = setInterval(tick, intervalMs);
		timer.unref?.();
		return {
			async stop() {
				stopped = true;
				clearInterval(timer);
				await running;
			},
		};
	};
}
