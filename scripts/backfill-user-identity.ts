/**
 * Backfill the agent "primary user" identity redesign onto EXISTING agents.
 *
 * `ncl provision` (src/cli/resources/provision.ts) now wires new agents'
 * human reply lane with local_name `user` (was `local-cli`) and labels the
 * lane's messaging group with the human's email (was the raw `web:google:<sub>`
 * platform id). This script applies the same rename/relabel to agents created
 * BEFORE that change, so their agent-runner's system prompt and `<message
 * from="...">` attribute read the same way. `container.json`'s new
 * `primaryUser` field needs no backfill — `materializeContainerJson`
 * recomputes it on every spawn (see src/container-config.ts).
 *
 * Idempotent + safe to re-run: only touches destinations still named
 * `local-cli`; skips (with a warning) any agent that already has a `user`
 * destination (would collide on the (agent_group_id, local_name) PK).
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-user-identity.ts [--dry-run]
 */
import path from 'path';

import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { DATA_DIR } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getMessagingGroup, updateMessagingGroup } from '../src/db/messaging-groups.js';
import { getDestinationByName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from '../src/modules/permissions/db/agent-group-members.js';
import { getUser } from '../src/modules/permissions/db/users.js';

const OLD_NAME = 'local-cli';
const NEW_NAME = 'user';

interface CliDestinationRow {
  agent_group_id: string;
  local_name: string;
  target_type: string;
  target_id: string;
}

/** Every `local-cli` channel destination still pending the rename. */
function findPendingDestinations(): CliDestinationRow[] {
  return getDb()
    .prepare(
      `SELECT agent_group_id, local_name, target_type, target_id
         FROM agent_destinations
        WHERE local_name = ? AND target_type = 'channel'`,
    )
    .all(OLD_NAME) as CliDestinationRow[];
}

function renameDestination(agentGroupId: string): void {
  getDb()
    .prepare(`UPDATE agent_destinations SET local_name = ? WHERE agent_group_id = ? AND local_name = ?`)
    .run(NEW_NAME, agentGroupId, OLD_NAME);
}

/** Project the renamed destination into every active session's inbound.db (see the
 * destination-projection invariant in src/modules/agent-to-agent/db/agent-destinations.ts). */
async function projectToLiveSessions(agentGroupId: string): Promise<void> {
  const { writeDestinations } = await import('../src/modules/agent-to-agent/write-destinations.js');
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    writeDestinations(agentGroupId, session.id);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const pending = findPendingDestinations();
  if (pending.length === 0) {
    console.log('Nothing to backfill — no `local-cli` destinations remain.');
    return;
  }

  let renamed = 0;
  let relabeled = 0;
  let skipped = 0;

  for (const row of pending) {
    const conflict = getDestinationByName(row.agent_group_id, NEW_NAME);
    if (conflict) {
      console.warn(
        `SKIP ${row.agent_group_id}: a \`${NEW_NAME}\` destination already exists (manual collision) — leaving \`${OLD_NAME}\` in place.`,
      );
      skipped++;
      continue;
    }

    const mg = getMessagingGroup(row.target_id);
    const [firstMember] = getMembers(row.agent_group_id);
    const human = firstMember ? getUser(firstMember.user_id) : undefined;
    const email = human?.display_name?.includes('@') ? human.display_name : undefined;

    if (dryRun) {
      console.log(
        `[dry-run] ${row.agent_group_id}: rename \`${OLD_NAME}\` -> \`${NEW_NAME}\`` +
          (email ? `, relabel mg ${row.target_id} -> "${email}"` : ` (no derivable email — name left as-is)`),
      );
      continue;
    }

    renameDestination(row.agent_group_id);
    renamed++;

    if (mg && email && mg.name !== email) {
      updateMessagingGroup(row.target_id, { name: email });
      relabeled++;
    }

    await projectToLiveSessions(row.agent_group_id);
  }

  if (dryRun) {
    console.log(`\nDry run: ${pending.length} agent(s) would be touched.`);
    return;
  }

  console.log(
    `\nBackfill complete: ${renamed} destination(s) renamed, ${relabeled} lane(s) relabeled, ${skipped} skipped.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
