# Architecture Decision Records

Una decisione architetturale o tecnologica = un file `NNNN-titolo-breve.md`, a partire da [0000-template.md](0000-template.md).

Nessuna scelta di stack entra nel codice senza un ADR in stato **Accepted**.

| ADR | Titolo | Stato |
|---|---|---|
| [0001](0001-runtime-backend-typescript-node-fastify.md) | Runtime backend: TypeScript su Node.js 26 LTS con Fastify 5 | Accepted |
| [0002](0002-database-sqlite-drizzle.md) | Database: SQLite (WAL) con better-sqlite3 e Drizzle ORM | Accepted |
| 0003 | Protocollo di streaming | Riservato: si scrive dopo lo spike S2, prima del lavoro su Stream Delivery |
| [0004](0004-contratto-api-openapi-3-1.md) | Contratto API: OpenAPI 3.1 scritto a mano, validazione da spec, codegen TS e Kotlin | Accepted |
| 0005 | Web client | Riservato: si scrive dopo lo spike S2, prima del lavoro sulla UI |
| [0006](0006-deploy-e-gateway.md) | Deploy Docker Compose e gateway Caddy | Accepted |
| [0007](0007-provider-metadata-e-offline.md) | Provider dei metadata (TMDB + base durevole Wikidata) e funzionamento offline | Accepted |

La valutazione completa delle aree tecnologiche è in [05 — Valutazione tecnologica](../architecture/05-technology-evaluation.md).

ADR previste, con numero da assegnare quando servono: client TV, accelerazione hardware del transcode (dopo H10), thumbnail, CI ospitata, backup fuori dall'host.
