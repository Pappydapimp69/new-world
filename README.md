# New World

A co-op platformer for two people on one keyboard, and the levels are written by
the players. Clear a level together, each of you locks in one change, and Claude
builds the next level from both.

Play: https://claude.ai/artifact/JFfMRHJHi5XYgiL4oi83mw

- Player 1: `A` `D` to move, `W` to jump. Player 2: arrow keys. `R` sends you both back to the start.
- You can stand on each other's heads. Both of you have to reach the gold door.

## Building the next level (for Claude)
When the players say "build the next level":
1. Read `rounds/level-<N>` from the Artifact's database (ArtifactData `get`). It should have `status: "ready"`.
2. `brain start <1-2 keywords from each request>`, and apply what comes back.
3. Add level N to `LEVELS` in `game/index.html`, with `asked`, `built` (one plain sentence),
   `map`, `rules`, and a `testPlan` that includes an `expect: "unreachable"` step for every co-op gate.
   Change the engine if a request needs a new mechanic, and add a matching move to the playtest search.
4. `node tools/playtest.js <N> --browser --shot <scratchpad>/lN.png` must PASS. Look at the screenshot.
5. Republish `game/index.html` to the same URL, then set the round doc's `status` to `"built"`.
6. Commit, push, and `brain note` anything you learned.

See `docs/adr/0001-level-loop.md`.
