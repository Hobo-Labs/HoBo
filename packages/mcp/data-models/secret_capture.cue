package mcp_secret_capture

import "strings"

// Constraints for the secret-capture MCP App's records (secret_capture.proto).
// Field names are the protobuf JSON names. Every definition is closed: a
// record that tries to carry the secret itself (a `value`, `secret` or
// `plaintext` field) does not unify with any of them.

#Name:    string & =~"^[A-Z][A-Z0-9_]{0,63}$"
#Target:  "runtime" | "deploy" | "writer"
#Channel: "mcp-app" | "url-elicitation" | "loopback-page"
#State:   "awaiting-owner" | "stored" | "authorized" | "expired" | "closed"
#Ticket:  string & =~"^cap_[A-Za-z0-9_-]{22}$"
#Time:    string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"
#B64u:    string & =~"^[A-Za-z0-9_-]+$"
// A store reference: the entry's infisical:// SecretRef, a fixture store's
// secref://, or a writer session's hobo-writer-session://.
#Ref: string & =~"^(infisical|secref|hobo-writer-session)://[A-Za-z0-9._~/:@-]{1,512}$"

#SecretCaptureSpec: close({
	name:     #Name
	target:   #Target
	label:    string & =~"^[^\\n]{1,80}$"
	purpose:  string & =~"^[^\\n]{1,240}$"
	minBytes: int & >=1
	maxBytes: int & >=minBytes & <=32768
	charset:  "printable-line" | "printable-multiline"
	pattern?: string & =~"^\\^.*\\$$"
})

#SecretCaptureKey: close({
	kty: "EC"
	crv: "P-256"
	x:   #B64u & =~"^.{43}$"
	y:   #B64u & =~"^.{43}$"
})

#SecretCaptureTicket: close({
	ticketId:  #Ticket
	name:      #Name
	target:    #Target
	channel:   #Channel
	state:     #State
	openedAt:  #Time
	expiresAt: #Time
	ref?:      #Ref
	url?:      string & =~"^http://127\\.0\\.0\\.1:[0-9]{1,5}/capture/cap_[A-Za-z0-9_-]{22}(#[A-Za-z0-9_-]{43})?$"
	key?:      #SecretCaptureKey
	label?:    string & =~"^[^\n]{1,80}$"
	purpose?:  string & =~"^[^\n]{1,240}$"
	charset?:  "printable-line" | "printable-multiline"
	maxBytes?: int & >=1 & <=32768
	// A stored or authorized capture names where it went.
	if state == "stored" || state == "authorized" {ref: #Ref}
	// Only the fallback channels have a page; only the app channel seals in
	// the host.
	if channel == "mcp-app" {url?: _|_}
})

#SecretCaptureSealed: close({
	ticketId:   #Ticket
	epk:        #SecretCaptureKey
	iv:         #B64u & =~"^.{16}$"
	ciphertext: #B64u & strings.MinRunes(22) & strings.MaxRunes(44000)
})

#SecretCaptureReceipt: close({
	ticketId: #Ticket
	name:     #Name
	stored:   bool
	ref:      #Ref
	status:   "stored" | "authorized"
	if status == "stored" {stored: true}
	if status == "authorized" {stored: false}
})

#SecretCaptureRefusal: close({
	code:      string & =~"^(SECRET_[A-Z_]+|MCP_APPS_NOT_NEGOTIATED)$"
	message:   string & =~"^[^\\n]{1,400}$"
	nextStep?: string & =~"^[^\\n]{1,400}$"
	name?:     #Name
})

#SecretCaptureEvent: close({
	schemaVersion: "hobo.secret-capture/v1"
	type:          "secret.CaptureOpened" | "secret.CaptureStored" | "secret.CaptureAuthorized" | "secret.CaptureRejected" | "secret.CaptureRefused" | "secret.CaptureExpired" | "secret.CaptureClosed"
	seq:           int & >=1
	time:          #Time
	ticketId?:     #Ticket
	name?:         #Name
	target?:       #Target
	channel?:      #Channel
	ref?:          #Ref
	code?:         string & =~"^[A-Za-z0-9_-]{1,64}$"
	if type == "secret.CaptureStored" || type == "secret.CaptureAuthorized" {ref: #Ref}
})

// The scoped fixture corpus (fixtures/secret_capture/) is vetted against
// this union.
#SecretCapture: #SecretCaptureSpec | #SecretCaptureTicket | #SecretCaptureSealed | #SecretCaptureReceipt | #SecretCaptureRefusal | #SecretCaptureEvent
