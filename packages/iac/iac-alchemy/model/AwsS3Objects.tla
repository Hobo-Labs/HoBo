--------------------------- MODULE AwsS3Objects ---------------------------
EXTENDS Naturals, TLC

CONSTANT MaxBytes
Bodies == {"empty", "small", "large"}
Digests == {"d0", "d1", "d2", "foreign"}
Size(b) == CASE b = "empty" -> 0 [] b = "small" -> 1 [] OTHER -> 2
Digest(b) == CASE b = "empty" -> "d0" [] b = "small" -> "d1" [] OTHER -> "d2"
VARIABLES exists, body, metadata, outcome, readBody, readMetadata, readSize
vars == <<exists, body, metadata, outcome, readBody, readMetadata, readSize>>
Init ==
  /\ exists = FALSE /\ body = "empty" /\ metadata = "foreign"
  /\ outcome = "none" /\ readBody = "empty" /\ readMetadata = "foreign" /\ readSize = 0
Write(b) ==
  /\ b \in Bodies /\ Size(b) <= MaxBytes
  /\ exists' = TRUE /\ body' = b /\ metadata' = Digest(b)
  /\ UNCHANGED <<outcome, readBody, readMetadata, readSize>>
External(b, m) ==
  /\ b \in Bodies /\ m \in Digests
  /\ exists' = TRUE /\ body' = b /\ metadata' = m
  /\ UNCHANGED <<outcome, readBody, readMetadata, readSize>>
Delete == /\ exists /\ exists' = FALSE /\ UNCHANGED <<body, metadata, outcome, readBody, readMetadata, readSize>>
Read ==
  /\ outcome' = IF ~exists THEN "missing"
                ELSE IF Size(body) <= MaxBytes /\ metadata = Digest(body)
                THEN "success" ELSE "unavailable"
  /\ readBody' = body /\ readMetadata' = metadata /\ readSize' = Size(body)
  /\ UNCHANGED <<exists, body, metadata>>
Next == (\E b \in Bodies: Write(b)) \/ (\E b \in Bodies: \E m \in Digests: External(b,m)) \/ Delete \/ Read
Spec == Init /\ [][Next]_vars
TypeOK == /\ exists \in BOOLEAN /\ body \in Bodies /\ metadata \in Digests
          /\ outcome \in {"none", "missing", "success", "unavailable"}
          /\ readBody \in Bodies /\ readMetadata \in Digests /\ readSize \in 0..2
SuccessfulReadsAreBounded == outcome = "success" => readSize <= MaxBytes
SuccessfulReadsMatchDigest == outcome = "success" => readMetadata = Digest(readBody)
NeverReadEmpty == ~(outcome = "success" /\ readBody = "empty")
NeverReadCorruption == ~(outcome = "unavailable" /\ readMetadata # Digest(readBody))
=============================================================================
