// Deterministic two-word Freight aliases (D2). The alias is a pure function
// of the Freight id: the first 32 bits of the digest pick the adjective and
// the next 32 bits pick the noun. The word lists are append-never wire
// contract: changing them would rename every recorded Freight.

// public-contract: alias adjectives (order is load-bearing).
export const ALIAS_ADJECTIVES: readonly string[] = Object.freeze(
	(
		"able acid aged airy alert amber ample apt arid ashen avid awake azure balmy bare bold brave breezy brief bright " +
		"brisk broad bronze brown bubbly busy calm candid carmine casual cedar chalky cheery chief chilly civic clean clear " +
		"clever close cloudy coastal cobalt cool copper coral cosmic cozy crisp curly cyan dainty dapper daring dawn deep deft " +
		"dense dewy direct distant dizzy dotted dusky dusty eager early earthy easy elated elder elfin ember epic even exact " +
		"fabled faint fair fancy fast feisty fern fiery final firm fleet fluent flying fond forest frank free fresh frosty " +
		"frugal gentle giant giddy gilded glad gleaming glossy golden grand granite grassy great green grey hardy hasty hazel " +
		"hearty hidden high hollow honest hopeful humble husky icy ideal idle indigo inky ionic ivory jade jaunty jolly jovial " +
		"joyful juicy just keen kind lanky large late lavish lazy leafy lean level light lilac limber lime linen little lively " +
		"lofty loyal lucid lucky lunar lush lyric magic major maple marble mellow merry mighty milky mint misty modest molten " +
		"mossy muted narrow neat nimble noble north novel oaken ocean olive opal open orange orchid pale paper pastel patient " +
		"peach pearl perky pine placid plain plucky plush polar polite prime proud quick quiet radiant rapid rare ready regal " +
		"rich rocky rosy round royal ruby rugged rustic sable safe sage salty sandy satin scarlet serene sharp shiny silent " +
		"silky silver simple sleek slim smooth snowy snug solar solid sonic spare spry steady steel stellar still stoic stormy " +
		"sturdy sunny super swift tall tame tawny teal tender tidy tiny topaz tranquil true tulip upbeat urban usual valid " +
		"vast velvet verdant vivid warm wavy wild windy wise witty woody young zany zesty zippy"
	).split(" "),
);

// public-contract: alias nouns (order is load-bearing).
export const ALIAS_NOUNS: readonly string[] = Object.freeze(
	(
		"acorn adder agate albatross alder anchor antelope apple arbor arch arrow aspen aster atlas aurora badger bagel " +
		"bamboo banjo barley barn basil basin bay beacon beagle bear beaver bee beetle bell birch bison blossom boat bobcat " +
		"bonsai boulder bramble breeze brook buffalo bunny burrow butte cabin cactus camel canal canary candle canoe canyon " +
		"cardinal caribou carrot castle cello chalet cherry chestnut cicada citrus clam clover cobra comet condor cougar cove " +
		"coyote crane creek cricket crow cypress daisy delta dingo dolphin dove dragon drum dune eagle egret elk elm emu " +
		"falcon fawn ferret fig finch fjord flame flint fox frog gazelle gecko geyser ginger glacier glen goose gopher gorge " +
		"grove gull harbor hare hawk heron hill hippo hornet ibis iguana inlet iris island ivy jackal jaguar jasper jay jetty " +
		"juniper kayak kelp kestrel kite kiwi koala lagoon lake lantern lark laurel lemon lemur leopard lily linden lion llama " +
		"lobster locust lotus lynx magpie mallard mango manta marmot marsh meadow mesa mink mole moose moth mountain mule " +
		"nebula newt nutmeg oak oasis ocelot octopus orbit orca orchard osprey otter owl oyster panda panther parrot peak " +
		"pebble pelican penguin pepper petrel pinto planet plover plum pond poplar prairie puffin puma quail quartz quasar " +
		"quill rabbit raccoon raven reef ridge river robin rocket rook rowan saddle salmon sapphire sequoia shark shell shore " +
		"shrike sloth sparrow spruce squid starling stork stream summit swallow swan tapir tern thicket thistle thrush tiger " +
		"toucan trout tundra turtle valley vireo vole walnut walrus warbler wasp willow wolf wombat wren yak yarrow zebra zephyr"
	).split(" "),
);

const ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The alias of a Freight id. Throws on a malformed id: ids are parsed before they reach here. */
export function freightAlias(freightId: string): string {
	if (!ID_PATTERN.test(freightId)) throw new TypeError(`not a Freight id: ${freightId}`);
	const hex = freightId.slice("sha256:".length);
	const adjective = Number.parseInt(hex.slice(0, 8), 16) % ALIAS_ADJECTIVES.length;
	const noun = Number.parseInt(hex.slice(8, 16), 16) % ALIAS_NOUNS.length;
	return `${ALIAS_ADJECTIVES[adjective]}-${ALIAS_NOUNS[noun]}`;
}
