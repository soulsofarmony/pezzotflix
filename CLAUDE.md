# CLAUDE.md — Pezzotflix (Home Media Platform)

Self-hosted home media platform for the owner's digitized Blu-ray / UHD Blu-ray collection (MKV remuxes). Streaming-service UX, original quality, proprietary clients, fully self-hosted. The project is developed mostly by Claude, guided and reviewed by the owner: optimize for correctness, clarity and maintainability.

Source of truth for requirements: `docs/requirements/0001-video-service-requirements-v0.1.md`. Read it before any design or implementation work.

## Current phase

**DESIGN → BUILD.** Since 2026-11-05 the owner has **delegated decisions to Claude**: Claude closes the design chain, chooses the stack (ADRs accepted by Claude) and builds the MVP autonomously. The owner reviews results and can request any change. Update this checklist as steps complete.

- [x] 0. Requirements v0.1 — `docs/requirements/`
- [x] 1. Domain model — `docs/architecture/01-domain-model.md`
- [x] 2. Components & responsibilities — `docs/architecture/02-components.md`
- [x] 3. Interfaces — `docs/architecture/03-interfaces.md`
- [x] 4. Playback architecture — `docs/architecture/04-playback-architecture.md`
- [ ] 5. Evidence spikes S1–S4 + H10 — `spikes/`, reports in `docs/spikes/` ← **in progress** (S1 ✅, S3 ✅, S4 ✅ (TMDB live blocked: no key), H10 ✅/❌, S2 automated run in progress; owner visual/audio check pending)
- [ ] 6. Technology evaluation + ADRs — `docs/architecture/05-technology-evaluation.md`, `docs/adr/` ← 0001/0002/0004/0006/0007 Accepted; 0003 (streaming) and 0005 (web client) after S2
- [x] 7. MVP implementation plan — `docs/architecture/06-mvp-plan.md` (build F0 in progress)

## Hard rules

- **Technology follows requirements.** No language, framework, DB, protocol or library is chosen for product code without an **Accepted** ADR in `docs/adr/`. Never pick tech "by habit" or convenience. Spikes may use whatever is fastest, because spike code is throwaway.
- **Delegated decisions (owner, 2026-11-05).** Claude decides design and technology and accepts its own ADRs, after a `design-reviewer` pass. Every decision still gets an ADR or a decision row, so the owner can audit and reverse it. Claude may push to `origin/main` at milestones. Owner-only items are listed under Agent workflow.
- **Language.** Documents under `docs/` are written in **Italian**. Code, identifiers, code comments, commit messages and PRs are in **English**.
- **Spikes are throwaway.** Code goes in `spikes/<id>-<name>/` and outputs in `out/` (gitignored). Reports go in `docs/spikes/<id>-<name>.md` with question, setup, measured results and a recommendation. Spike code is never promoted: reimplement it properly.
- **Never commit media.** Test media lives in `media-samples/` (gitignored).

## Agent workflow

The main session is the **orchestrator**: it scopes the work, delegates to project agents, reviews what they return, keeps the docs consistent, commits, and talks to the owner. Agents never commit; the orchestrator integrates, reviews and commits.

- Agents (`.claude/agents/`):
  - `spike-runner` runs one spike and writes its report;
  - `tech-evaluator` covers one decision area and drafts its ADR as Proposed;
  - `design-reviewer` is a read-only critic, run before a decision is accepted or a document is final.
  Implementation agents (`module-implementer`, `code-reviewer`) are defined once the stack ADRs are Accepted.
- Skills (`.claude/skills/`): `spike-report` (spike lifecycle) and `adr` (ADR lifecycle).
- **Parallelism:** independent work runs in parallel agents, one decision area or spike each. Work that shares a scarce tool (Docker daemon, GPU, the browser) runs in sequence. Product code is built one module per agent, each in its own git worktree, and integrates through the contract-first API spec.
- **Owner-only:** spending money, creating external accounts or API keys, physical checks (HDR colours, audio on the AVR), real media, and anything irreversible outside the repo. Ask for these up front and in batches; never block on them, work around and record what is pending.
- **Dev tools:** the orchestrator keeps the toolchain (WSL, Docker Desktop, ffmpeg, Node, Python) up to date on its own. Only steps that need the owner (UAC prompts, licences) go to them.

## Architectural invariants (from requirements)

- Services are independent containers (Video ≠ Music), each able to start, stop, update and be replaced on its own. One service failing must not take down the others.
- Media storage is external and mounted **read-only** into the Video Service. DB, cache, artwork and thumbnails live on separate volumes. The storage backend (host dir → disks → NAS) must be swappable without redesign.
- **Direct Play is preferred**; transcoding is a fallback. Never degrade the media when it isn't needed.
- Three delivery tiers must be designed in: **Direct Play** / **Direct Stream** (remux, video copied, audio possibly converted) / **Transcode**. Browsers rarely direct-play Blu-ray remuxes (MKV container, TrueHD/DTS-HD audio, PGS subs).
- Never assume one audio track per video, or one subtitle track. Detect all tracks.
- Never assume every Video is a Movie. The catalog includes Movie, Documentary, Series → Season → Episode, and Extra (attachable to other items).
- Ingest is **automatic-first, manually-correctable**. Unmatched or ambiguous items go to a "Da verificare" queue. Metadata is cached locally, so the library must work without the external API.
- Profiles share the library. Progress, history, watchlist and watched state are per profile. The MVP uses profile selection without auth; real auth comes with remote access.
- LAN-only for the MVP, but no logic may assume that client and server are on the same subnet.
- MVP: 1 streaming session. Architecture targets up to 3 heterogeneous sessions.
- Out of scope: ripping/remuxing (done externally), a recommendation engine, and Work→Edition→Version modeling (different cuts are separate items for now).

- Video Service is a **modular monolith** (one container) with module boundaries from `02-components.md`. Stream Delivery sits behind an internal interface so it can be extracted into a `video-worker` container later. Media processing always runs in child processes.
- The gateway serves the web client's static assets. The admin UI (unmatched queue, corrections) is a section of the web client.
- API is **contract-first**: a machine-readable spec in the repo is the source of truth and clients are generated from it. The control plane returns data-plane locators, and media URLs are authorized by a session token in the URL (native players can't set headers). The server composes Home. Client capabilities are declared by the client and can be overridden server-side per device. The MVP uses polling for notifications.
- Playback: **minimum necessary transformation**. Positions always use the original media timeline. Audio selection is quality-first (best track in the preferred language, minimal conversion). MVP ships full Direct Play and Direct Stream plus a minimal software Transcode **for sources up to 1080p only** (1 at a time, configurable, separate from the session limit). 4K sources are Direct Play/Direct Stream only (decision P2, revised after S3; a temporary deviation from requirements §5.2 that depends on H2/H7 from S2); hardware-accelerated transcode is re-evaluated after H10. PGS in the browser is rendered client-side if spike S2 validates it, otherwise burned in. A Direct Play failure automatically re-plans with a heavier mode.

## Environment

- Dev and first real use: Windows 11 + Docker Desktop (WSL2). A Linux mini-PC/server comes later, so keep everything portable.
- Host tools: Docker Desktop 4.98 (engine 29) on WSL 3.0.3, NVIDIA RTX 3060 Ti (driver 596), Node 22 (system) + portable Node 26.13 in `%LOCALAPPDATA%\pezzotflix-tools\node26` (bash: `export PATH="$LOCALAPPDATA/pezzotflix-tools/node26:$PATH"`) (project runtime, ADR 0001), Python 3.12, ffmpeg/ffprobe 7. No .NET or Go installed.
- Bind mounts from NTFS into WSL2 containers are slow. Keep this in mind for scanning/watching (inotify does not propagate reliably from Windows paths).
- Main TV client: Android TV / Google TV device (Chromecast GTV / Google TV Streamer or a Google TV set) → AVR/soundbar over HDMI. Lossless audio passthrough (TrueHD/Atmos, DTS-HD) matters. **Known risk:** Dolby Vision profile 7 (FEL) is unreliable on these devices and usually falls back to HDR10, so it is not an MVP requirement.
- No real media yet: use public test samples. Subtitle formats are unknown, so treat PGS as likely.

## Repo map

- `docs/requirements/`: requirements
- `docs/architecture/`: design chain
- `docs/library-standard.md`: naming and folder standard for the media library, what the Identifier expects
- `docs/adr/`: decisions
- `docs/spikes/`: spike reports
- `services/`: backend services
- `clients/`: web / tv / mobile
- `spikes/`: throwaway code
- `deploy/`: Docker Compose
- `media-samples/`: local test media (ignored)
