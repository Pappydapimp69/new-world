# ADR 0002: Player types and the Sound-engine

Status: accepted · 2026-11-06 · from the Level 2 turns ("add music using the sound engine";
"give one player powers the other player doesn't have, and make it more like pokemon")

## Decision
- **Types, not a single powered player.** Each player gets a type with powers the other lacks
  (`rules.types`): Ember walks through fire, melts ice by pushing into it, sinks in water; Tide
  swims and is hurt by fire. Giving both players a type keeps each one needed (Tide opens Ember's
  gate, Ember opens Tide's door), which a one-sided power would not. Type exclusivity is
  measured, not assumed: the playtest proves each type-locked star and gate is unreachable for
  the other type.
- **Mechanics, not a recreation.** "More like Pokemon" is read as the genre mechanic (elemental
  types with matching obstacles), with original names and art.
- **Sound comes from Pappydapimp69/Sound-engine**, vendored by `brain engine vendor` and inlined
  by `tools/inline-sound.js` so the Artifact stays one file. The worklet loads from a blob URL,
  falling back to a data URL, then a published `sound/worklet.js`.
- **Music intensity only ratchets up within a level** (lever 0.45, ice 0.7, at the door 0.9),
  because bar-quantized layer switching fails on states that flicker faster than a bar (Brain
  zanegpt#E148). Mute suspends the AudioContext instead of fading (Brain brain-films#E2). Audio
  only reads sim events, so replays and playtests stay exact (Brain sound-engine#E7).

## Measured
- `tools/musiccheck.mjs` renders each song through the engine's own MusicKernel: no clipping
  at any intensity (peak ≤ 0.62) and 1.56–1.57× louder from calm to tense.
- In Chromium the engine starts from the blob URL, plays the level's song, and the output is
  audible (rms ≈ 0.05, peak ≈ 0.2); mute suspends the context.
- Not measured: whether claude.ai's page security policy allows blob or data worklets. The
  fallback chain covers it, and the Sound button shows "No sound" if all three fail.
