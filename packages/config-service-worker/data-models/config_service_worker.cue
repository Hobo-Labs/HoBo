package config_service_worker

// Constraints for HoBo's config-service Worker (ADR-0179 amendment, Worker
// addendum 2026-11-12). Field names are the protobuf JSON names. The Worker
// applies the same constraints in `src/worker/binding.ts` and `src/worker/
// store.ts`; the Node side in `src/binding.ts` and `src/records.ts`.

#Https: string & =~"^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)*$"

#StoreId: string & =~"^[a-z0-9]{16,32}$"

#Folder: "relay" | "deploy"

// An entry name is an environment variable name.
#EntryName: string & =~"^[A-Z][A-Z0-9_]{0,127}$"

// Values are at most 16 KiB; CUE counts runes, the Worker counts UTF-8 bytes.
#EntryValue: string & =~"^[^\\x00]{0,16384}$"

#VercelOidcReader: {
	issuer:      #Https & =~"^https://oidc\\.vercel\\.com/[a-z0-9][a-z0-9-]{0,99}$"
	audience:    string & =~"^https://vercel\\.com/[a-z0-9][a-z0-9-]{0,99}$"
	subject:     string & =~"^owner:[a-z0-9-]+:project:[A-Za-z0-9._-]+:environment:[a-z0-9-]+$"
	ownerId:     string & =~"^team_[A-Za-z0-9]{1,64}$"
	projectId:   string & =~"^prj_[A-Za-z0-9]{1,64}$"
	environment: string & =~"^[a-z0-9][a-z0-9-]{0,63}$"
}

#GithubOidcWriter: {
	issuer:        "https://token.actions.githubusercontent.com"
	audience:      string & =~"^urn:hobo:config-service:[a-z0-9]{16,32}$"
	repository:    string & =~"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$"
	ref:           string & =~"^refs/heads/[A-Za-z0-9._/-]{1,200}$"
	repositoryId?: string & =~"^[0-9]{1,20}$"
}

#ConfigServiceWorkerBinding: {
	storeId:            #StoreId
	relay:              #VercelOidcReader
	deploy:             #GithubOidcWriter
	bootstrapSha256:    string & =~"^[0-9a-f]{64}$"
	bootstrapExpiresAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
	// The GitHub audience names this store, so a token minted for another
	// store is refused here.
	deploy: audience: "urn:hobo:config-service:\(storeId)"
}

#ConfigServiceOwnerAccess: {
	issuer:   string & =~"^https://[a-z0-9][a-z0-9-]{0,62}\\.cloudflareaccess\\.com$"
	audience: string & =~"^[A-Za-z0-9]{16,128}$"
}

#ConfigFolderEntries: {
	entries?: {[#EntryName]: #EntryValue}
}

#ConfigServiceSeed: {
	folders: {[#Folder]: #ConfigFolderEntries}
}

#ConfigFolderWrite: {
	entries?: {[#EntryName]: #EntryValue}
	delete?: [...#EntryName]
}

#ConfigFolderRead: {
	folder:   #Folder
	entries?: {[#EntryName]: #EntryValue}
	version?: int & >=0
}

#ConfigFolderWritten: {
	folder: #Folder
	names?: [...#EntryName]
	version: int & >=1
}

#ConfigServiceSeeded: {
	folders: [...#ConfigFolderWritten]
}

#ConfigServiceHealth: {
	service: "hobo-config-service"
	storeId: #StoreId
	nonce:   string & =~"^[A-Za-z0-9_-]{16,64}$"
}

#ConfigAuditEntry: {
	at:        string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
	principal: "bootstrap" | "vercel-relay" | "github-deploy" | "owner"
	action:    "seed" | "write" | "denied"
	folder:    #Folder
	names?: [...#EntryName]
}

#ConfigAuditLog: {
	entries?: [...#ConfigAuditEntry]
}

#ConfigServiceError: {
	code:    string & =~"^[A-Z][A-Z0-9_]{2,63}$"
	message: string & =~"^[^\\n]{1,300}$"
}

// The flat fixture corpus holds deploy-time bindings.
#ConfigServiceWorker: #ConfigServiceWorkerBinding
