package vercel

// Ids only: an Infisical store, its folder, and the workload identity.
#CdStoreBinding: {
  kind: "infisical-cloud-attach" | "infisical-self-hosted"
  endpoint: string & =~"^https://"
  projectId: string & !=""
  environment: string & !=""
  secretPath: string & =~"^/"
  relayIdentityId: string & =~"^[0-9a-f-]{36}$"
  ...
}

#CdNotReady: {
  ready: false
  started: false
  code: "cd-store-binding-missing" | "cd-store-binding-invalid" | "cd-journal-not-provisioned" | "cd-start-failed" | (string & =~"^[a-z][a-z0-9-]*$")
}

#CdHealth: {
  ok: true
  commit: string | null
}
