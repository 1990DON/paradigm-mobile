# Stage 7.5 Development Backend

Start on loopback with an environment-configured development token:

```bash
export PARADIGM_DEV_TOKEN='replace-with-a-local-development-token'
npm run backend:start
```

The default database is `.data/paradigm-stage75.sqlite`, and the default loopback port is `8787`.
Override them with `PARADIGM_DB_PATH` and `PARADIGM_PORT`. `PARADIGM_DEV_USER` defaults to `dev-user`.

Run the real SQLite and HTTP integration suite:

```bash
npm run backend:test
```

Health does not require authentication. All other endpoints require `x-api-key` containing
`PARADIGM_DEV_TOKEN`.

SQLite is a development/reference persistence adapter only. It does not provide production
multi-instance isolation, distributed locking, HA durability, or production authentication.
