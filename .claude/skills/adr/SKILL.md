---
name: adr
description: Create, review or accept a Pezzotflix Architecture Decision Record in docs/adr/. Use for any technology choice for product code (language, framework, DB, protocol, library, deploy).
---

# ADR workflow

- Numbering: next free `NNNN` in `docs/adr/`; file `NNNN-short-kebab-title.md` from `0000-template.md`. Written in **Italian**.
- **Proposed** ADRs are drafted by the `tech-evaluator` agent (one decision area each) or by you. Each must cite requirements (§) and evidence (spike reports, sources with dates).
- Before showing them to the owner, run `design-reviewer` over all ADRs of the batch together, to catch cross-ADR conflicts.
- Only the owner accepts. After explicit approval: set **Stato: Accepted** and the date, add the row to the table in `docs/adr/README.md`, and commit with `docs(adr): accept NNNN <title>`.
- An ADR that changes a previous one marks the old one `Superseded by NNNN`; never edit an Accepted ADR's decision in place.
- No product code may use a technology that has no Accepted ADR.
