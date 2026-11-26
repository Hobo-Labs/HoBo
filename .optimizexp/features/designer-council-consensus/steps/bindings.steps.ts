import { Given, Then, When } from "@cucumber/cucumber";
import {
	activatePersona,
	advanceSpeakingTurns,
	approveOneHead,
	assertCloseoutAllowed,
	assertConsensus,
	assertMayReply,
	assertMonotonicDecay,
	assertNay,
	assertNotMergeEligible,
	assertPreferencesYielded,
	assertReconvene,
	assertReworkAppended,
	assertYayExitZero,
	assertYayFails,
	changeHead,
	decideCouncil,
	fiveYays,
	noHardBlocker,
	oneBlockerNay,
	seedRelevantJony,
	setFeature,
	sixYays,
	supportConcernWithCurrentEvidence,
	votesMatchCurrentSubject,
} from "./implementations.ts";
import { createWorld } from "./world.ts";

let singleton = createWorld();

Given("persona {string} is active", function (persona: string) {
	singleton = createWorld();
	activatePersona(singleton, persona);
});
Given("feature {string} is under optimizexp review", function (feature: string) {
	setFeature(singleton, feature);
});
Given("a proposal is central to Jony Ive's coherence doctrine", function () {
	seedRelevantJony(singleton);
});
Given("current-head evidence supports the concern", function () {
	supportConcernWithCurrentEvidence(singleton);
});
When("the council advances through speaking turns", function () {
	advanceSpeakingTurns(singleton);
});
Then("Jony Ive may reply while investment is above zero", function () {
	assertMayReply(singleton);
});
Then("investment decays monotonically", function () {
	assertMonotonicDecay(singleton);
});
Then("subjective preferences yield at zero", function () {
	assertPreferencesYielded(singleton);
});
Given("five designers vote yay", function () {
	fiveYays(singleton);
});
Given("one designer has an unresolved evidence-backed blocker and votes nay", function () {
	oneBlockerNay(singleton);
});
When("the coordinator decides the council", function () {
	decideCouncil(singleton);
});
Then("the result is nay", function () {
	assertNay(singleton);
});
Then("a rework packet is appended to the agent bus", function () {
	assertReworkAppended(singleton);
});
Then("the PR is not merge eligible", function () {
	assertNotMergeEligible(singleton);
});
Given("all six canonical designers vote yay", function () {
	sixYays(singleton);
});
Given("no hard blocker remains", function () {
	noHardBlocker(singleton);
});
Given("every vote matches the current head and proposal digest", function () {
	votesMatchCurrentSubject(singleton);
});
When("the coordinator asserts consensus", function () {
	assertConsensus(singleton);
});
Then("assert-yay exits zero", function () {
	assertYayExitZero(singleton);
});
Then("SDLC closeout may proceed", function () {
	assertCloseoutAllowed(singleton);
});
Given("the council unanimously approved one head SHA", function () {
	approveOneHead(singleton);
});
When("the PR head changes", function () {
	changeHead(singleton);
});
Then("assert-yay fails", function () {
	assertYayFails(singleton);
});
Then("the council must reconvene", function () {
	assertReconvene(singleton);
});
