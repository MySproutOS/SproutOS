import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    /*
      The applications are listed rather than globbed.

      `apps/*` matched `apps/frontends`, which is a *directory of* applications rather than one — so
      the dashboard and admin SPAs were collected under a project rooted there, with no config and
      no aliases, and anything importing through `@frontends/dashboard` could not load. Globbing
      both `apps/*` and `apps/frontends/*` collects those files twice, under one project that works
      and one that cannot.
    */
    projects: [
      "packages/*",
      "apps/dbmigrator",
      "apps/internal-api",
      "apps/website",
      "apps/frontends/*",
      "lib/typescript/*",
    ],
  },
})
