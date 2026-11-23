package hobo

import "strings"

#OwnerHandoff: #OwnerHandoffRegistration | #OwnerHandoffOffer | #OwnerHandoffEnvelope | #OwnerHandoffCollected | #OwnerHandoffSealedAnswer

#HandoffDigest: =~"^[A-Za-z0-9_-]{43}$"

#HandoffPublicKey: =~"^B[A-P][A-Za-z0-9_-]{85}$"

#HandoffExpiry: int & >0 & <=9007199254740991

#OwnerHandoffOffer: {
	mailboxId:    #HandoffDigest
	recipientKey: #HandoffPublicKey
	binding:      #HandoffDigest
	expiresAtMs:  #HandoffExpiry
	keyProof:     #HandoffDigest
}

#OwnerHandoffRegistration: {
	offer:         #OwnerHandoffOffer
	collectDigest: #HandoffDigest
}

#OwnerHandoffEnvelope: {
	senderKey:  #HandoffPublicKey
	iv:         =~"^[A-Za-z0-9_-]{16}$"
	ciphertext: =~"^[A-Za-z0-9_-]+$" & strings.MinRunes(22) & strings.MaxRunes(21846)
}

#OwnerHandoffCollected: {
	envelope: #OwnerHandoffEnvelope
}

#HandoffAnswerName: "store" | "INFISICAL_PROJECT_ID" | "OP_VAULT_ID" | "OP_CONNECT_HOST" | "BITWARDEN_SERVER_URL" | "INFISICAL_CLI_SESSION" | "ONEPASSWORD_EMAIL" | "ONEPASSWORD_SECRET_KEY" | "ONEPASSWORD_PASSWORD" | "BW_CLIENTID" | "BW_CLIENTSECRET"

#OwnerHandoffSealedAnswer: {
	v:         1
	mailboxId: #HandoffDigest
	binding:   #HandoffDigest
	answer: {
		store: "infisical" | "1password" | "bitwarden"
		[#HandoffAnswerName]: string & strings.MaxRunes(16384)
	}
}
