# ADR 0001: The level loop

Status: accepted · 2026-11-06

## Context
New World is a game for two people on one keyboard. They clear a level together,
then each writes one change, and Claude builds the next level from both. The
build step has to run in a Claude Code session so it can query Brain, edit the
engine when a request needs new mechanics, and playtest before shipping.

## Decision
- **One page, published as a claude.ai Artifact** from `game/index.html`. Levels
  live in the `LEVELS` array in that file, so a new level is a code change, and
  a request like "add a double jump" can change the engine too.
- **Turns go through the Artifact's `db` capability**, in `rounds/level-<N>`
  (`p1`, `p2`, `p1Locked`, `p2Locked`, `status`: drafting → ready → built).
  Claude reads it with ArtifactData, so nobody has to copy and paste.
  Player names are in `meta/players`.
- **The simulation is pure** (between `SIM-START` and `SIM-END`), so
  `tools/playtest.js` runs the exact game code in Node.
- **Every level ships only after `node tools/playtest.js <n> --browser` passes.**
  The players chose this (Brain tension T65: test before publishing, because game
  bugs only show up during play). The playtest runs a search over held inputs
  between standing spots and finds a solve for each `testPlan` step. Steps
  marked `expect: "unreachable"` must find nothing, which proves a co-op gate
  really needs both players. It then replays the whole solution from a fresh
  start and requires a win, checks every star can be reached, and runs a
  browser smoke test of the real page.

## Consequences
- Each level is one republish to the same Artifact URL. Open tabs reload by
  themselves.
- The search only covers moves the planner knows about (walks, and jumps with
  3 hold lengths × 3 steering patterns). A level that needs a new verb needs a
  matching macro in `tools/playtest.js`, or the playtest will say it is
  unsolvable.
- A full playtest takes about 3 minutes.
