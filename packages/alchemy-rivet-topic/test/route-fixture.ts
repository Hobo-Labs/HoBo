/** Test-only host stub; production must verify exclusive durable ownership. */
export const testStateOwnership = {
	backendRef: "test:state",
	ownershipEpoch: "test:epoch",
	verify: () => true,
};
