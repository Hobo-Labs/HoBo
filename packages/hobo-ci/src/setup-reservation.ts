export type SetupEffectResult<T> =
	| { readonly kind: "completed"; readonly value: T; readonly receipt: string }
	| { readonly kind: "not-dispatched"; readonly value: T };

export interface SetupReservation {
	durableReceipt(effect: string): Promise<string | undefined>;
	runDurableEffectWithReceipt<T>(
		effect: string,
		operation: () => Promise<SetupEffectResult<T>>,
	): Promise<T>;
}

export interface SetupReservationAuthority {
	runExclusive<T>(
		operation: (reservation: SetupReservation) => Promise<T>,
	): Promise<T>;
}
