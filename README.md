# Code 92 Command Center

Internal bilingual (Arabic/English) command centre for Code 92's AI product
portfolio — one place to see what we're building, where each product stands,
what the market is saying about it, and whether it was built responsibly.

**Live:** https://5nteb3xb.insforge.site · **Access:** internal only; sign-up is
open but an admin must activate the account before it reads anything.

---

## What it does

| Area | Summary |
|---|---|
| **Product registry** | Stage, health, owner, keywords, review cadence. Health and stage are derived from status history, never typed directly. |
| **Status timeline** | Append-only-by-content update history that drives each product's derived state. |
| **Work items** | Per-product tasks with sub-tasks, assignees, due dates and document attachments (markdown is read in place), plus a cross-product view. |
| **Releases** | Per-product cycles with scoped work, a risk-tiered checklist, a waiver-gated ship step and an append-only transition log. |
| **Notifications** | Database-driven task notifications — assignment, completion, edits — in an in-app bell, with opt-in email drained out of band. |
| **Knowledge base** | Articles, notes and sources — taggable, linkable to products, with search that works in both English and Arabic. |
| **Market intelligence** | A scheduled AI pipeline that finds recent trend items per product and scores their relevance. |
| **Implementation lifecycle** | Six phases (Ideation → Monitor) with risk-tiered gates and uploaded document evidence per phase. |
| **Governance** | Portfolio-wide coverage, stuck products, the waiver register and the full gate log. |
| **GitHub mirroring** | Each product links to one private repo in `code92-dev`; lifecycle evidence is committed into it. |

Full behaviour is specified in **[SPECIFICATION.md](SPECIFICATION.md)**.

## Stack

Next.js 15.5 (App Router, Server Components + Server Actions) · React 19 ·
TypeScript · Tailwind 3.4 · next-intl · [InsForge](https://insforge.dev)
(Postgres + RLS, auth, storage, edge functions) · deployed to Vercel via the
InsForge CLI.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000 → redirects to /en
```

Requires a `.env.local` with the backend URL and public anon key:

```
NEXT_PUBLIC_INSFORGE_URL=...
NEXT_PUBLIC_INSFORGE_ANON_KEY=...
```

Both are non-secret (the anon key is public by design — RLS is what protects the
data). `.env*` is gitignored and excluded from deploys; production values are set
as persistent deployment variables.

Scripts: `npm run dev` · `npm run build` · `npm start` · `npm run lint`.
Type-check with `npx tsc --noEmit`.

## Layout

```
app/[locale]/      routes: /, /products, /tasks, /knowledge, /trends,
                   /governance, /admin, /login
components/        UI, grouped by feature (lifecycle/, governance/, products/, …)
lib/               vocabulary + queries; lib/actions/* are Server Actions
migrations/        every schema change, in order — the real data model
functions/         Deno edge functions: trend-scan, github-sync
messages/{en,ar}/  one JSON file per namespace, both locales required
i18n/              routing, navigation helpers, namespace registry
```

## Conventions that are not optional

- **Migrations only move forward.** Never edit an applied migration; add a new
  one. `npx @insforge/cli db migrations new <name>` then `… up --all`.
- **Authorisation lives in Postgres.** RLS policies, column-scoped grants and
  `SECURITY DEFINER` functions are the boundary; UI checks are for navigation
  only. A rule enforced only in a component is not enforced.
- **A table-level grant extends to columns added later.** If you add a column to
  a table that has a table-level INSERT/UPDATE grant, re-grant column-scoped or
  the new column becomes client-writable. This has already caused one real bug.
- **Logical Tailwind utilities only** — `ms/me`, `ps/pe`, `start/end`,
  `text-start`, `border-s/e`. Physical `ml/mr/pl/pr/left/right/text-left/
  text-right` are banned; the single RTL switch is `<html dir>`.
- **Every user-visible string comes from a message file**, added to **both**
  locales in the same change.
- Some rules are mirrored in two places on purpose — the lifecycle gate matrix
  (`lib/lifecycle.ts` ↔ SQL) and the GitHub error codes (`lib/github.ts` ↔
  `functions/github-sync.ts`). **Change both together.**

## Deploying

```bash
npx @insforge/cli deployments deploy .
```

Read **[DEPLOY.md](DEPLOY.md)** before optimising anything — it documents the
measured latency structure, and why the dominant cost is geographic rather than
architectural.

## Documentation

| Document | Contents |
|---|---|
| [SPECIFICATION.md](SPECIFICATION.md) | What the system does — roles, domain model, every module, security model |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | How it was built, milestone by milestone, and what's outstanding |
| [DESIGN.md](DESIGN.md) | Design tokens, typography, responsive shell, RTL hard rules |
| [DEPLOY.md](DEPLOY.md) | Deployment, measured production latency, the planned region move |
| [AGENTS.md](AGENTS.md) | InsForge conventions for coding agents |

## Current status

Deployed and in use. Two items to be aware of before relying on the newest
feature set:

- **GitHub mirroring is inert until a credential exists.** An admin must create a
  fine-grained PAT owned by the `code92-dev` organisation (Contents: read and
  write) and save it under Admin → GitHub.
- **No automated security scan has run** against this schema — the InsForge
  advisor is unavailable on this project because `pg_stat_statements` is not
  installed. It reports "no issues" over an empty result set, which is not the
  same as passing.

See the Outstanding section of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
for the full list.
