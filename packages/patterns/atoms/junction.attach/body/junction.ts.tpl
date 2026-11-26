export interface JunctionAttach {
	readonly junctionId: string;
	readonly localYard: string;
	readonly peerYard: string;
}

export function attach{{name}}Junction(peerYard: string): JunctionAttach {
	return {
		junctionId: "junction:{{name}}",
		localYard: "yard:{{name}}",
		peerYard,
	};
}
