export class PrivateOwnerRequestError extends Error {
	constructor() {
		super("The private owner request could not be prepared.");
	}
}

export class PrivateOwnerDispatchError extends Error {
	constructor() {
		super("The private owner request did not complete.");
	}
}
