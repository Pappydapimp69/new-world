# New World

A co-op platformer for two people on one keyboard, and the levels are written by
the players. Clear a level together, each of you locks in one change, and Claude
builds the next level from both.

Play: https://claude.ai/artifact/JFfMRHJHi5XYgiL4oi83mw

- Player 1: `A` `D` to move, `W` to jump. Player 2: arrow keys. `R` sends you both back to the start.
- Controllers: stick or d-pad to move, `A` to jump, `Start` or `A` to begin, `Y` to regroup. Controller 1 plays player 1 and controller 2 plays player 2 (swap on the page).
- You can stand on each other's heads. Both of you have to reach the gold door.
- From Level 2 on, each player has a type: Ember walks through fire and melts ice but sinks in water; Tide swims but fire hurts.
- Stand on your partner's head to ride along when they walk or jump. Checkpoint flags save where you stood; falling sends you back there, and Regroup sends you both to your own flags.
- Music and sound effects come from the Sound-engine (vendored in `vendor/sound-engine` by `brain engine vendor`, inlined into the page by `node tools/inline-sound.js`). The Sound button mutes.

## Building the next level (for Claude)
Standing rule from the players: query Brain, measure in the sim, and iterate until
each fix holds, then ship. Nothing gets published on a guess. Every change is measured
with `tools/playtest.js` (and a sim probe for any tuning number), and gets re-measured
after each fix until it passes.

When the players say "build the next level":
1. Read `rounds/level-<N>` from the Artifact's database (ArtifactData `get`). It should have `status: "ready"`.
2. Read how they actually played: the `runs` collection (ArtifactData `list`), one record per try with who fell, where (tile x, y), from what, time, stars and whether they cleared it. Fix or design around the spots they really struggled with; the page shows the same summary on the world and write screens.
3. `brain start <1-2 keywords from each request>`, and apply what comes back.
4. Add level N to `LEVELS` in `game/index.html`, with `asked`, `built` (one plain sentence),
   `map`, `rules`, and a `testPlan` that includes an `expect: "unreachable"` step for every co-op gate.
   Change the engine if a request needs a new mechanic, and add a matching move to the playtest search.
5. Quick suites (seconds): `node tools/mechanics.test.js` (each mechanic against a predicted number), `node tools/golden.js` (seeded trajectories must stay identical after a sim refactor; `--coverage` shows what they hit, `--update` only for an intended change), `node tools/fitcheck.js`, `node tools/musiccheck.mjs`.
   The level proof: `node tools/playtest.js <N> --browser --shot <scratchpad>/lN.png`, `node tools/fitcheck.js` and `node tools/musiccheck.mjs` must all PASS, and `node tools/playlog.test.js` (the play log, against a stand-in database). Look at the screenshots.
   A new song goes in `SONGS`; a level picks it with `song:`. After updating `vendor/sound-engine`, rerun `node tools/inline-sound.js`.
6. Republish `game/index.html` to the same URL, then set the round doc's `status` to `"built"`.
7. Commit, push, and `brain note` anything you learned.

See `docs/adr/0001-level-loop.md`.
