# db/migrations — status

These migration modules and the new `src/db/connection.ts` (`initDb()` /
`runMigrations()`) are **not wired into the production startup path** as of
the v2-merge branch. Production code still opens `~/.nanoclaw/store/messages.db`
via the legacy `src/db.ts:initDatabase()` because the v2 schema is back-compat
with v1 and no real migration is required for the v1→v2 upgrade today.

The numbered scaffold (001-013, 100-104) is kept intact because:

1. The ordering and module-keyed `schema_version` design are already
   coordinated across modules (permissions / approvals / agent-to-agent),
   and re-deriving that later would be more work than carrying it forward.
2. The first time v2.next introduces a real schema break, the wiring to
   call `initDb(workspacePath('store/v2.db'))` + `runMigrations(db)` from
   `src/index.ts:main()` is a one-line change.
3. Tests for these migrations already exist alongside the modules and
   keep them honest under `vitest`.

If you're adding a new module: feel free to add another `1xx-fork-*.ts`
file. Just remember the production wiring still has to land before users
will see the table.
