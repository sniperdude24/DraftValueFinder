// Lineup slots for the browser. The definition lives in src/analyze/lineup.js
// and is served over the /shared/ route, so the page, the server and the tests
// all fill a lineup the same way rather than keeping three copies of the slot
// list in step by hand.
export { SLOTS, FLEX_ELIGIBLE, assignSlots } from '/shared/lineup.js';
