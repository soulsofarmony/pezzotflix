# deploy

Orchestrazione Docker Compose della piattaforma (dopo la tech selection).

Principi: media storage montato **read-only**; database, cache e artwork su volumi separati; ogni servizio isolato dagli altri.
