// Constraints on values accepted or produced by the conditional R2 client.
package r2_object

import "strings"

#ObjectScope: {
	accountId:      string & =~"^[a-f0-9]{32}$"
	bucket:         string & =~"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$"
	jurisdiction?:  "eu" | "fedramp" | "us"
	maxObjectBytes: int & >=1024 & <=8388608
	timeoutMs:      int & >=1 & <=30000
}

#ObjectKey: string & strings.MinRunes(1) & strings.MaxRunes(950) & =~"^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$"
#StrongETag: string & strings.MinRunes(3) & strings.MaxRunes(256) & =~"^\"[!#-~]+\"$"

#ConditionalWrite: {
	key:  #ObjectKey
	body: string
	// Body size in UTF-8 is bounded by ObjectScope.maxObjectBytes at runtime.
	condition: {kind: "absent"} | {kind: "match", etag: #StrongETag}
}

#ObjectRead: {key: #ObjectKey}
#ReadObjectResult: {body: string, etag: #StrongETag}
#ConditionalWriteResult: {applied: false, etag?: _|_} | {applied: true, etag?: #StrongETag}
