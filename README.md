# Pezzotflix — Home Media Platform

Piattaforma home media self-hosted per la fruizione della propria collezione audiovisiva digitalizzata (remux di Blu-ray / UHD Blu-ray), con un'esperienza paragonabile a uno streaming commerciale ma con pieno controllo sui file, qualità originale e client proprietari.

## Stato

**Fase: design.** Requisiti v0.1 definiti; in corso la catena di design (domain model → componenti → interfacce → playback → valutazione tecnologica → piano MVP). Nessuno stack tecnico è ancora stato scelto — la tecnologia deriverà dai requisiti tramite ADR.

## Mappa del repo

| Percorso | Contenuto |
|---|---|
| `docs/requirements/` | Requisiti di prodotto e di sistema |
| `docs/architecture/` | Documenti della catena di design |
| `docs/adr/` | Architecture Decision Records (una decisione per file) |
| `docs/spikes/` | Report degli esperimenti di evidenza |
| `services/` | Servizi backend (es. Video Service) — dopo la tech selection |
| `clients/` | Client proprietari (web, TV, mobile) — dopo la tech selection |
| `spikes/` | Codice sperimentale throwaway |
| `deploy/` | Orchestrazione Docker Compose |
| `media-samples/` | File media di test locali (ignorati da git) |

## Documenti chiave

- [Requisiti Video Service v0.1](docs/requirements/0001-video-service-requirements-v0.1.md)
- [Indice architettura](docs/architecture/README.md)
- [Indice ADR](docs/adr/README.md)
