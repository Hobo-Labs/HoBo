package readiness

import "strings"

#CiDagger: #Readiness | #CheckConfig

#CheckConfig: {
 engine?: "" | "local" | =~"^((image|container)(\\+(docker|podman|apple|finch|nerdctl))?|unix|tcp|tls|ssh|kube-pod)://[^[:space:]\\x00]+$"
 cliVersion: =~"^1\\.[0-9]+\\.[0-9]+(-beta\\.[0-9]+)?$"
 workspace?: string & strings.MaxRunes(500)
 if workspace != _|_ {
  if workspace != "" && workspace != "." {
   workspace: !~"^/|\\\\|\\x00"
   _validPath: true
   for segment in strings.Split(workspace, "/") {
    _validPath: segment != "" && segment != "." && segment != ".."
   }
  }
 }
 filters?: [...string & =~"^[^-[:space:]\\x00][^[:space:]\\x00]*$"]
 skip?: [...string & =~"^[^-[:space:]\\x00][^[:space:]\\x00]*$"]
 parallel?: int & >=0 & <=256
 failFast?: bool
 timeoutSeconds?: int & >=0 & <=86400
 environment?: "" | =~"^[A-Za-z0-9_][A-Za-z0-9_.-]*$"
}

#Readiness: {
 integration: "dagger"
 status: "implemented"
 executionAvailable: true
 targetSdk: "@dagger.io/dagger"
 targetDocumentation: "https://docs.dagger.io/"
 pendingGates: [string & =~"\\S", ...string & =~"\\S"]
}
