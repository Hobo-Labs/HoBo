-------------------------- MODULE ResolutionSignature ----------------------
EXTENDS Naturals
CONSTANTS RequireTrust, RequireKeyMatch, RequireSignature, RequireDigest, RequireSigningMatch, RequirePublicOnly
VARIABLES mode, enrolled, sameKey, valid, digest, signingMatch, publicOnly, phase
vars == <<mode, enrolled, sameKey, valid, digest, signingMatch, publicOnly, phase>>
Init == /\ mode \in {"sign", "verify"} /\ enrolled \in BOOLEAN /\ sameKey \in BOOLEAN
        /\ valid \in BOOLEAN /\ digest \in BOOLEAN /\ signingMatch \in BOOLEAN /\ publicOnly \in BOOLEAN /\ phase = "pending"
Allowed == IF mode = "sign"
           THEN /\ (IF RequireSigningMatch THEN signingMatch ELSE TRUE)
                /\ (IF RequirePublicOnly THEN publicOnly ELSE TRUE)
           ELSE /\ (IF RequireTrust THEN enrolled ELSE TRUE)
                /\ (IF RequireKeyMatch THEN sameKey ELSE TRUE)
                /\ (IF RequireSignature THEN valid ELSE TRUE)
                /\ (IF RequireDigest THEN digest ELSE TRUE)
                /\ (IF RequirePublicOnly THEN publicOnly ELSE TRUE)
Accept == /\ phase = "pending" /\ Allowed /\ phase' = "accepted"
          /\ UNCHANGED <<mode, enrolled, sameKey, valid, digest, signingMatch, publicOnly>>
Refuse == /\ phase = "pending" /\ ~Allowed /\ phase' = "refused"
          /\ UNCHANGED <<mode, enrolled, sameKey, valid, digest, signingMatch, publicOnly>>
Done == /\ phase \in {"accepted", "refused"} /\ UNCHANGED vars
Next == Accept \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"sign", "verify"} /\ enrolled \in BOOLEAN /\ sameKey \in BOOLEAN
          /\ valid \in BOOLEAN /\ digest \in BOOLEAN /\ signingMatch \in BOOLEAN /\ publicOnly \in BOOLEAN
          /\ phase \in {"pending", "accepted", "refused"}
EnrolledSigner == phase = "accepted" /\ mode = "verify" => enrolled /\ sameKey
ValidSignature == phase = "accepted" /\ mode = "verify" => valid
MatchingDigest == phase = "accepted" /\ mode = "verify" => digest
MatchingSigningKeys == phase = "accepted" /\ mode = "sign" => signingMatch
PublicKeysOnly == phase = "accepted" => publicOnly
=============================================================================
