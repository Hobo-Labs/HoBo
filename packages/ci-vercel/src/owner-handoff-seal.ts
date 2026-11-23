export type OwnerHandoffOfferWire = Readonly<{
	mailboxId: string;
	recipientKey: string;
	binding: string;
	expiresAtMs: number;
	keyProof: string;
}>;

export type OwnerHandoffEnvelopeWire = Readonly<{
	senderKey: string;
	iv: string;
	ciphertext: string;
}>;

export type OwnerHandoffSealing = Readonly<{
	mailboxOf(ticket: string): Promise<string>;
	verifyOffer(ticket: string, offer: OwnerHandoffOfferWire): Promise<boolean>;
	seal(
		ticket: string,
		offer: OwnerHandoffOfferWire,
		answer: Readonly<Record<string, string>>,
	): Promise<OwnerHandoffEnvelopeWire>;
}>;

export function ownerHandoffSealing(): OwnerHandoffSealing {
	const subtle = globalThis.crypto.subtle;
	const encoder = new TextEncoder();
	const bytesOf = (text: string) => {
		const bytes = encoder.encode(text);
		const owned = new Uint8Array(bytes.length);
		owned.set(bytes);
		return owned;
	};
	const toBase64Url = (buffer: ArrayBuffer | Uint8Array) => {
		const bytes = new Uint8Array(buffer);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary)
			.replace(/\+/gu, "-")
			.replace(/\//gu, "_")
			.replace(/=+$/u, "");
	};
	const fromBase64Url = (text: string) => {
		if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new Error("not base64url");
		const binary = atob(
			text.replace(/-/gu, "+").replace(/_/gu, "/") +
				"===".slice((text.length + 3) % 4),
		);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1)
			bytes[index] = binary.charCodeAt(index);
		return bytes;
	};
	const ticketBytes = (ticket: string) => {
		const bytes = fromBase64Url(ticket);
		if (bytes.length !== 32) throw new Error("not a hand-off ticket");
		return bytes;
	};
	const derive = async (
		secret: Uint8Array<ArrayBuffer>,
		salt: Uint8Array<ArrayBuffer>,
		info: string,
	) =>
		new Uint8Array(
			await subtle.deriveBits(
				{ name: "HKDF", hash: "SHA-256", salt, info: bytesOf(info) },
				await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]),
				256,
			),
		);
	const proofText = (offer: OwnerHandoffOfferWire) =>
		`v1|${offer.mailboxId}|${offer.recipientKey}|${offer.binding}|${offer.expiresAtMs}`;
	const bindKey = async (ticket: string) =>
		subtle.importKey(
			"raw",
			await derive(
				ticketBytes(ticket),
				new Uint8Array(0),
				"hobo owner-handoff bind v1",
			),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
	return {
		async mailboxOf(ticket) {
			return toBase64Url(
				await derive(
					ticketBytes(ticket),
					new Uint8Array(0),
					"hobo owner-handoff mailbox v1",
				),
			);
		},
		async verifyOffer(ticket, offer) {
			const mailboxId = toBase64Url(
				await derive(
					ticketBytes(ticket),
					new Uint8Array(0),
					"hobo owner-handoff mailbox v1",
				),
			);
			if (offer.mailboxId !== mailboxId) return false;
			return subtle.verify(
				"HMAC",
				await bindKey(ticket),
				fromBase64Url(offer.keyProof),
				bytesOf(proofText(offer)),
			);
		},
		async seal(ticket, offer, answer) {
			ticketBytes(ticket);
			const sender = await subtle.generateKey(
				{ name: "ECDH", namedCurve: "P-256" },
				true,
				["deriveBits"],
			);
			const recipient = await subtle.importKey(
				"raw",
				fromBase64Url(offer.recipientKey),
				{ name: "ECDH", namedCurve: "P-256" },
				false,
				[],
			);
			const shared = new Uint8Array(
				await subtle.deriveBits(
					{ name: "ECDH", public: recipient },
					sender.privateKey,
					256,
				),
			);
			const senderKey = toBase64Url(
				await subtle.exportKey("raw", sender.publicKey),
			);
			const key = await subtle.importKey(
				"raw",
				await derive(
					shared,
					fromBase64Url(offer.mailboxId),
					`hobo owner-handoff seal v1|${senderKey}|${offer.recipientKey}`,
				),
				"AES-GCM",
				false,
				["encrypt"],
			);
			const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
			const ciphertext = await subtle.encrypt(
				{
					name: "AES-GCM",
					iv,
					additionalData: bytesOf(`v1|${offer.mailboxId}|${offer.binding}`),
				},
				key,
				bytesOf(
					JSON.stringify({
						v: 1,
						mailboxId: offer.mailboxId,
						binding: offer.binding,
						answer,
					}),
				),
			);
			return {
				senderKey,
				iv: toBase64Url(iv),
				ciphertext: toBase64Url(ciphertext),
			};
		},
	};
}
