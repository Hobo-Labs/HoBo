--------------------------- MODULE ReplayOrdering ---------------------------
EXTENDS Naturals, Sequences
\* Two distinct keys, two insertion orders, and three abstract collations.
CONSTANTS StableV2, PreserveMarker, LegacyIsOne, RejectUnknown
VARIABLES phase, requested, leftInput, rightInput, leftLocale, rightLocale,
          leftOrder, rightOrder, marker, interpreted
vars == <<phase, requested, leftInput, rightInput, leftLocale, rightLocale,
          leftOrder, rightOrder, marker, interpreted>>
Orders == {<<"k1", "k2">>, <<"k2", "k1">>}
Locales == {"english", "swedish", "tied"}
Rank(key, locale, version) ==
  IF version = "v2" /\ StableV2
  THEN IF key = "k1" THEN 1 ELSE 2
  ELSE CASE locale = "english" -> IF key = "k1" THEN 1 ELSE 2
         [] locale = "swedish" -> IF key = "k1" THEN 2 ELSE 1
         [] OTHER -> 1
Sorted(pair, locale, version) ==
  IF Rank(pair[1], locale, version) <= Rank(pair[2], locale, version)
  THEN pair ELSE <<pair[2], pair[1]>>
Init == /\ phase = "requested"
        /\ requested \in {"v1", "v2", "v3", "legacy"}
        /\ leftInput \in Orders /\ rightInput \in Orders
        /\ leftLocale \in Locales /\ rightLocale \in Locales
        /\ leftOrder = <<>> /\ rightOrder = <<>>
        /\ marker = "absent" /\ interpreted = "none"
Encode == /\ phase = "requested"
          /\ requested # "legacy"
          /\ IF requested = "v3" /\ RejectUnknown
             THEN /\ phase' = "refused"
                  /\ UNCHANGED <<leftOrder, rightOrder, marker>>
             ELSE /\ phase' = "encoded"
                  /\ leftOrder' = Sorted(leftInput, leftLocale, requested)
                  /\ rightOrder' = Sorted(rightInput, rightLocale, requested)
                  /\ marker' = requested
          /\ UNCHANGED <<requested, leftInput, rightInput, leftLocale,
                          rightLocale, interpreted>>
ReadLegacy == /\ phase = "requested" /\ requested = "legacy"
              /\ phase' = "read"
              /\ interpreted' = IF LegacyIsOne THEN "v1" ELSE "v2"
              /\ UNCHANGED <<requested, leftInput, rightInput, leftLocale,
                              rightLocale, leftOrder, rightOrder, marker>>
ReadMarked == /\ phase = "encoded" /\ phase' = "read"
              /\ interpreted' = IF PreserveMarker THEN marker ELSE "v1"
              /\ UNCHANGED <<requested, leftInput, rightInput, leftLocale,
                              rightLocale, leftOrder, rightOrder, marker>>
Done == /\ phase \in {"read", "refused"} /\ UNCHANGED vars
Next == Encode \/ ReadLegacy \/ ReadMarked \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"requested", "encoded", "read", "refused"}
          /\ requested \in {"v1", "v2", "v3", "legacy"}
          /\ leftInput \in Orders /\ rightInput \in Orders
          /\ leftLocale \in Locales /\ rightLocale \in Locales
          /\ leftOrder \in Orders \cup {<<>>}
          /\ rightOrder \in Orders \cup {<<>>}
          /\ marker \in {"v1", "v2", "v3", "absent"}
          /\ interpreted \in {"v1", "v2", "v3", "none"}
PortableV2 == (requested = "v2" /\ phase \in {"encoded", "read"}) => leftOrder = rightOrder
CorrectVersion == phase = "read" => interpreted = IF requested = "legacy" THEN "v1" ELSE requested
RefuseUnknown == requested = "v3" => phase \notin {"encoded", "read"}
=============================================================================
