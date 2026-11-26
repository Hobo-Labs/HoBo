package hobo

// CUE constraints for S3-02 @hobo/identity draft POC records.

#PrincipalRef: {
  kind: "user" | "agent" | "service" | "workload"
  id: string & != ""
}

#CodeVersion: {
  digest: =~"^sha256:[a-f0-9]{64}$"
  version: string & != ""
}

#ScopeEntry: {
  port: string & != ""
  resource: string & != ""
  verbs: [...string] & != []
}

#AttestationBinding: {
  runId: string & != ""
  tenant: string & != ""
  parentPrincipal: #PrincipalRef
  codeVersion: #CodeVersion
  componentImageDigest: =~"^sha256:[a-f0-9]{64}$"
}

#JwtSvidRecord: {
  identityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  scope: [...#ScopeEntry] & != []
  expiresAt: string & != ""
  signerKid: string & != ""
}

#IdentityIssuedEventData: {
  identityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  scope: [...#ScopeEntry] & != []
  expiresAt: string & != ""
}

#IdentityRotatedEventData: {
  identityId: string & != ""
  previousIdentityId: string & != ""
  subject: =~"^spiffe://yard/"
  svidRef: =~"^tokenref://identity/svid/"
  expiresAt: string & != ""
}

#IdentityServiceEvidence: {
  issue: string & != ""
  summary: string & != ""
  eventFamilies: [...string] & != []
}
