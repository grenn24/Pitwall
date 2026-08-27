import { shellQuote, wslExec } from '../wsl/exec'
import { sanitizeSegment } from '../workspace/paths'
import type { AppDetection } from '../../shared/preview'

/**
 * Postgres image is pinned. A preview environment that quietly changes major
 * version between two runs of the same ticket is a debugging nightmare nobody
 * would think to suspect.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine'

const DB_USER = 'pitwall'
const DB_PASSWORD = 'pitwall'
const DB_NAME = 'app'

/** Seed file locations, in the order a project is likely to use them. */
const SEED_CANDIDATES = ['seed.sql', 'db/seed.sql', 'sql/seed.sql', 'prisma/seed.sql', 'database/seed.sql']

/**
 * Written when a project has no seed of its own.
 *
 * Deliberately not empty: a reviewer opening a preview against a database with
 * no tables cannot tell a working seed path from a broken one. One table that
 * obviously came from us makes the difference visible.
 */
export const DEFAULT_SEED = `-- Written by Pitwall because this project has no seed file.
-- Add one at seed.sql and it will be used instead.
CREATE TABLE IF NOT EXISTS pitwall_smoke (
  id    SERIAL PRIMARY KEY,
  note  TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pitwall_smoke (note) VALUES ('seeded by pitwall');
`

export function projectName(slug: string, ticketId: string): string {
  // Compose project names must be lowercase and start alphanumeric.
  return `pitwall-${sanitizeSegment(slug)}-${sanitizeSegment(ticketId, 'ticket')}`.slice(0, 60)
}

/** Find the project's seed file, or null when it has none. */
export async function findSeed(distro: string, worktreePath: string): Promise<string | null> {
  const tests = SEED_CANDIDATES.map((c) => `test -f ${shellQuote(`${worktreePath}/${c}`)} && echo ${shellQuote(c)}`).join(' || ')
  const { stdout } = await wslExec(distro, `${tests} || true`)
  const found = stdout.trim().split(/\r?\n/).filter(Boolean)[0]
  return found ?? null
}

/**
 * Work out how to run the project's app.
 *
 * No inference beyond reading what the project already declares. Guessing a
 * start command from a package.json is a bottomless pit, and when it guesses
 * wrong it fails in a way that looks like our bug rather than a missing file.
 */
export async function detectApp(distro: string, worktreePath: string): Promise<AppDetection> {
  const compose = await wslExec(
    distro,
    `cd ${shellQuote(worktreePath)} && for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do [ -f "$f" ] && echo "$f" && break; done`
  )
  const composeFile = compose.stdout.trim().split(/\r?\n/).filter(Boolean)[0]
  if (composeFile) return { source: 'compose', port: 3000, file: composeFile }

  const dockerfile = await wslExec(distro, `test -f ${shellQuote(`${worktreePath}/Dockerfile`)} && echo yes || echo no`)
  if (dockerfile.stdout.trim() === 'yes') {
    // EXPOSE is the only place a Dockerfile states its port. Absent one, 3000 is
    // the convention for the web stacks this is aimed at.
    const exposed = await wslExec(
      distro,
      `grep -iE '^[[:space:]]*EXPOSE[[:space:]]+[0-9]+' ${shellQuote(`${worktreePath}/Dockerfile`)} | head -1 | grep -oE '[0-9]+' | head -1 || true`
    )
    const port = Number(exposed.stdout.trim())
    return { source: 'dockerfile', port: Number.isFinite(port) && port > 0 ? port : 3000, file: 'Dockerfile' }
  }

  return { source: 'none', port: 3000 }
}

export interface ComposeInput {
  project: string
  worktreePath: string
  seedPath: string
  app: AppDetection
  appPort: number
  dbPort: number
}

/**
 * Generate the compose file for one ticket.
 *
 * Written to our own state directory rather than into the worktree: the
 * worktree is the agent's workspace and every file in it shows up in the diff
 * the user reviews. Infrastructure we generate is not part of the change.
 */
export function renderCompose(input: ComposeInput): string {
  const { project, worktreePath, seedPath, app, appPort, dbPort } = input

  const db = `  db:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    ports:
      - "${dbPort}:5432"
    volumes:
      - "${seedPath}:/docker-entrypoint-initdb.d/10-seed.sql:ro"
    healthcheck:
      # The app must not start against a database that is listening but has not
      # finished running its seed, or the first request races the schema.
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
      interval: 2s
      timeout: 3s
      retries: 40
      start_period: 3s
    tmpfs:
      # Throwaway by design. A preview database that survives teardown is a
      # preview database that drifts from the seed.
      - /var/lib/postgresql/data
`

  const appService =
    app.source === 'none'
      ? ''
      : `  app:
    build:
      context: "${worktreePath}"
      dockerfile: Dockerfile
    ports:
      - "${appPort}:${app.port}"
    environment:
      DATABASE_URL: "postgres://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}"
      PORT: "${app.port}"
      HOST: "0.0.0.0"
      NODE_ENV: development
    depends_on:
      db:
        condition: service_healthy
`

  return `# Generated by Pitwall. Do not edit — regenerated on every preview start.
name: ${project}
services:
${db}${appService}`
}

export function databaseUrl(dbPort: number): string {
  return `postgres://${DB_USER}:${DB_PASSWORD}@localhost:${dbPort}/${DB_NAME}`
}

export { DB_NAME, DB_USER, POSTGRES_IMAGE }
