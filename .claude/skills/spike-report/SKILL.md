---
name: spike-report
description: Orchestrate a Pezzotflix evidence spike (S#/H#) — delegate to the spike-runner agent, review with design-reviewer, update doc 04 §10 and the spikes index, then commit. Use when starting or finishing a spike.
---

# Spike workflow

1. **Scope.** Identify spike ID, question and hypotheses from `docs/architecture/04-playback-architecture.md` §10 and `docs/spikes/README.md`. List what needs the owner (secrets, hardware, eyes/ears) and ask for it up front.
2. **Delegate.** Launch the `spike-runner` agent with: spike ID + folder name, the exact hypotheses, the available inputs (media in `media-samples/`, env vars), and any time limit. Independent spikes can run in parallel; spikes that share a tool (Docker, GPU, a browser) run in sequence.
3. **Review.** Run `design-reviewer` on the report. Fix blockers/majors yourself or send them back to the agent.
4. **Propagate.** Make sure doc 04 §10 rows, `docs/spikes/README.md` and any affected design decision (doc 04 §11, docs 01–03) reflect the verdict. A refuted hypothesis that changes an approved decision must be surfaced to the owner, not silently rewritten.
5. **Commit.** One commit per spike: `spike(<id>): <what was measured>`. Media and `out/` never committed.
6. **Report to the owner** in Italian: verdict per hypothesis, key numbers, decisions needed.
