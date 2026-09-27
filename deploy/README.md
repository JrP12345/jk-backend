# Optional combined Docker deployment

These files are for an operator running both prebuilt frontend and backend
images on one Docker host. Render deployments do not use this Compose setup.

Copy `.env.example` to `.env` in this directory, configure image tags and
production credentials, then run from this directory:

```sh
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

Images must already be built and published; Compose does not clone or build the
other repository. MongoDB and Redis are externally managed. See
[backend deployment](../DEPLOYMENT.md) for worker and readiness requirements.
