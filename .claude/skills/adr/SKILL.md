---
name: adr
description: Create, review or accept a Pezzotflix Architecture Decision Record in docs/adr/. Use for any technology choice for product code (language, framework, DB, protocol, library, deploy).
---

# ADR workflow

- Numbering: next free `NNNN` in `docs/adr/`; file `NNNN-short-kebab-title.md` from `0000-template.md`. Written in **Italian**.
- **Proposed** ADRs are drafted by the `tech-evaluator` agent (one decision area each) or by you. Each must cite requirements (§) and evidence (spike reports, sources with dates).
- Before accepting, run `design-reviewer` over all ADRs of the batch together, to catch cross-ADR conflicts.
- Decisions are delegated to Claude (CLAUDE.md "Delegated decisions"): Claude accepts after the review pass and its fixes. Set **Stato: Accepted**, the date and the decider ("Claude, su delega del proprietario"), add the row to the table in `docs/adr/README.md`, and commit with `docs(adr): accept NNNN <title>`.
- An ADR that changes a previous one marks the old one `Superseded by NNNN`; never edit an Accepted ADR's decision in place.
- No product code may use a technology that has no Accepted ADR.
