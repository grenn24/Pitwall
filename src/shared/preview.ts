/**
 * Wire types for preview environments: one app container and one seeded
 * database container per ticket, described by a compose file we generate.
 */

export interface PreviewPorts {
  /** Host port the app is published on. Reachable from Windows as localhost. */
  app: number
  /** Host port Postgres is published on, so a human can connect with psql. */
  db: number
}

export interface PreviewEnv {
  ticketId: string
  /** Compose project name. Namespaces every container, network and volume. */
  project: string
  ports: PreviewPorts
  /** What the reviewer opens. */
  url: string
  /** Connection string for the seeded database, from the Windows side. */
  databaseUrl: string
  /** Absolute path, inside the distro, of the generated compose file. */
  composePath: string
}

export type PreviewPhase =
  | 'idle'
  | 'writing-compose'
  | 'starting-database'
  | 'building-app'
  | 'waiting-for-app'
  | 'ready'
  | 'failed'

export interface PreviewStatus {
  phase: PreviewPhase
  env: PreviewEnv | null
  /** Present when phase is 'failed'. Written for a human, not a log parser. */
  error?: string
  /** How the app image was determined. */
  appSource?: 'dockerfile' | 'compose' | 'none'
  elapsedMs?: number
}

/** Why a repo cannot get a preview, when it cannot. */
export interface AppDetection {
  source: 'dockerfile' | 'compose' | 'none'
  /** Container port the app listens on. */
  port: number
  /** Path, relative to the worktree, of whatever we found. */
  file?: string
}
