// CUE constraints for every protobuf type in data-models/connect_ui.proto.
// The connect page's loopback boundary: closed action names, string params,
// closed step and directive kinds, and store references that are references.
package connect_ui

#ConnectActionName: "connect.chooseStore" | "connect.start" | "connect.cancel"
#StoreId:           "infisical" | "1password" | "bitwarden"
#Provider:          "github" | "vercel"

#ConnectActionRequest: {
	action: #ConnectActionName
	params: {[string]: string}
}

#BrowserDirectiveRecord: {
	kind:    "none" | "navigate" | "post"
	url?:    =~"^https://"
	fields?: {[string]: string}
}

#ConnectViewRecord: {
	step:       "choose-secret-store" | "create-github-app" | "authorize-vercel" | "depositing" | "connected" | "failed"
	terminal:   bool
	composedBy: "model" | "deterministic"
	spec: {
		root: string & !=""
		elements: {[string]: {type: string & !="", ...}}
		...
	}
	directive: #BrowserDirectiveRecord
}

#ConnectedReferences: {
	provider: #Provider
	store:    #StoreId
	// A reference names where a value lives; it never is the value.
	references: [...=~"^(infisical|op|bitwarden)://"]
}
