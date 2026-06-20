# idea.md — Product vision

> The "why" of Curio. Read [prd.md](./prd.md) for the requirements and
> [implementation.md](./implementation.md) for the architecture. Living document —
> edited as the vision sharpens.

**Working name:** TBD (project codename: Curio)
**Owner:** dbs6207@psu.edu
**Context:** Hackathon project (Amazon). *Hackathon status matters only for licensing
decisions (e.g. tldraw watermark is acceptable) — it does NOT constrain product scope.
We plan the full vision.*

## One-liner

Take notes in the fastest, least-resistive way possible: a student *talks through*
a topic as if explaining it to a friend, and the system builds a living whiteboard
of structured notes, diagrams, and study artifacts in real time.

## The core bet — the Feynman Technique

The product is an **elicitation tool, not a transcription tool.** The student
explains a topic out loud in their own words (the Feynman Technique). The act of
explaining *is* the studying; the notes are a high-quality byproduct.

- Voice is the **primary interface for input.** Looking at the board is a reference
  activity, not the main loop — so it's fine for the board to move/animate while the
  student talks; their train of thought lives in the speaking, not the watching.
- The whiteboard is the **primary interface for output** — a Miro/tldraw-style canvas.

## What the AI companion does

- **Asks clarifying questions — but only *sometimes*.** It is not chatty. An
  inference step decides whether a question is actually warranted.
- **Surfaces gaps as gaps.** When the student doesn't know something, the system does
  **not** fill it in with its own knowledge. The gap stays on the board as an open
  question / red flag — a visible "you don't understand this yet" marker. This is a
  core study feature and protects Feynman integrity (the understanding must be the
  student's, not the bot's).
- **Talks back on pauses.** Clarifying questions, gap flags, and bigger prompts are
  raised when the student naturally pauses, not mid-sentence.
- **No real-time interruptions (for now).** We deliberately dropped "interrupt the
  moment the student goes down the wrong path." Wrong-path detection may still happen
  quietly inside the inference step and surface later, but the bot does not cut in.

## Modes

- **Solo "think-out-loud" mode** — the v1 experience. Like taking notes at home,
  talking to yourself / a friend.
- **Class mode** — *later.* Passive lecture capture (no interruption, one-way
  firehose, structure afterward) is a future, separate mode. Not in initial scope.

## Product principles (non-goals for v1)

These keep the product honest to the core bet:

- **No lecture/"class" mode in v1** (future).
- **No separate study mode / spaced-repetition** — study artifacts are board-only.
- **No real-time interruptions** — the bot does not cut in mid-thought.
- **No uploaded-material grounding in v1** — model knowledge only.
- **No direct editing of structured artifacts** — editing is always raw-then-regenerate
  (see [prd.md](./prd.md) §"Editing is raw-only").
