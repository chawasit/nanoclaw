/**
 * Backfill the Agent Home workspace memory + orientation layer onto EXISTING
 * agents (e.g. chawanrat, the Chief of Staff) created before agent-home.ts
 * existed.
 *
 * `initGroupFilesystem` already applies this seeding defensively on every
 * spawn (it's idempotent — see group-init.ts), so agents get it automatically
 * on their next wake. This script exists for the immediate case: backfilling
 * WITHOUT waiting for a spawn, e.g. right after a spine deploy.
 *
 * Idempotent + safe to re-run, and NEVER destructive:
 *   - IDENTITY/USER/SOUL/MEMORY/BOOTSTRAP.md are written ONLY if missing —
 *     an agent's own edits (or a prior run's seed) are never overwritten.
 *   - CLAUDE.local.md's Agent Home manual block is regenerated (replaced) so
 *     template fixes reach existing agents; everything else in the file (the
 *     mandate seed, the personality block, the onboarding block, and any
 *     notes the agent wrote) is left untouched.
 *   - Skips a group with no on-disk folder yet (nothing to backfill).
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-agent-home.ts [--dry-run]
 */
import fs from 'fs';
import path from 'path';

import { applyPrimaryUserToUserFile, seedAgentHomeFiles, upsertAgentHomeManual } from '../src/agent-home.js';
import { resolvePrimaryUser } from '../src/container-config.js';
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const groups = getAllAgentGroups();
  if (groups.length === 0) {
    console.log('Nothing to backfill — no agent groups exist.');
    return;
  }

  let filesSeeded = 0;
  let manualsRefreshed = 0;
  let usersBackfilled = 0;
  let skippedNoDir = 0;

  for (const group of groups) {
    const groupDir = path.join(GROUPS_DIR, group.folder);
    if (!fs.existsSync(groupDir)) {
      skippedNoDir++;
      continue;
    }

    if (dryRun) {
      const wouldWrite = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md', 'BOOTSTRAP.md'].filter(
        (f) => !fs.existsSync(path.join(groupDir, f)),
      );
      console.log(
        `[dry-run] ${group.id} (${group.folder}): would seed [${wouldWrite.join(', ') || 'none — already present'}], refresh CLAUDE.local.md manual`,
      );
      continue;
    }

    const written = seedAgentHomeFiles(groupDir);
    if (written.length > 0) {
      filesSeeded += written.length;
      console.log(`${group.id} (${group.folder}): seeded ${written.join(', ')}`);
    }

    if (upsertAgentHomeManual(groupDir)) {
      manualsRefreshed++;
    }

    const primaryUser = resolvePrimaryUser(group.id);
    if (primaryUser && applyPrimaryUserToUserFile(groupDir, primaryUser)) {
      usersBackfilled++;
      console.log(`${group.id} (${group.folder}): backfilled USER.md from primary user ${primaryUser.name}`);
    }
  }

  if (dryRun) {
    console.log(`\nDry run: ${groups.length} agent group(s) considered, ${skippedNoDir} skipped (no folder yet).`);
    return;
  }

  console.log(
    `\nBackfill complete: ${filesSeeded} stub file(s) seeded, ${manualsRefreshed} manual(s) refreshed, ` +
      `${usersBackfilled} USER.md backfilled from primary user, ${skippedNoDir} skipped (no folder yet).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
