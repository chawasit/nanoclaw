/**
 * Agent Home — workspace memory + orientation layer (openclaw-inspired).
 *
 * Seeds the per-agent stub files (IDENTITY/USER/SOUL/MEMORY/BOOTSTRAP.md) into
 * the group dir (host `groups/<folder>/`, bind-mounted at container path
 * `/workspace/agent/`) plus the CLAUDE.local.md operating-manual block that
 * explains the workspace layout, the communication model, and the
 * memory/documentation methodology. Adapted from openclaw's workspace files
 * to nanoclaw + the Claude Agent SDK — see
 * `docs/agent-home-memory-orientation-spec.md` (Circle repo) for the design.
 *
 * FULL PATHS ONLY (owner rule): every file/dir reference here is a full,
 * resolvable `/workspace/agent/...` path — an agent wakes fresh with no CWD
 * assumption, so a bare filename is a dead reference.
 *
 * Idempotent by design:
 *   - Stub files (IDENTITY/USER/SOUL/MEMORY/BOOTSTRAP.md) are written ONLY if
 *     missing — never overwritten, so an agent's own edits are never
 *     clobbered by a later spawn or a backfill run.
 *   - The CLAUDE.local.md manual block is delimited by start/end markers and
 *     is fully REPLACED on every call (so template fixes reach existing
 *     agents on their next spawn or a backfill run) while everything else in
 *     the file — the mandate seed, the personality block, the onboarding
 *     block, and any notes the agent wrote — is left untouched.
 *   - USER.md's Name/How-to-address/Email lines are placeholder text until
 *     `applyPrimaryUserToUserFile` swaps them for the resolved primary user
 *     (called at spawn time, once `resolvePrimaryUser` has data). It only
 *     replaces a line that is STILL the placeholder, so agent edits win.
 */
import fs from 'fs';
import path from 'path';

export const USER_NAME_PLACEHOLDER =
  '- **Name:** (unknown — filled in automatically once your workspace is wired to a person)';
export const USER_ADDRESS_PLACEHOLDER = '- **How to address them:** (unknown)';
export const USER_EMAIL_PLACEHOLDER = '- **Email:** (unknown)';

/** Marker delimiters for the describe-header block at the top of each stub file (below). */
export const FILE_HEADER_START = '<!-- file-header:start -->';
export const FILE_HEADER_END = '<!-- file-header:end -->';

/**
 * Single source of truth for the describe-header — purpose / write-here /
 * not-here — embedded at the top of IDENTITY.md, USER.md, SOUL.md, and
 * MEMORY.md. Consumed by both the stub templates below (new agents) and
 * `upsertFileHeaders` (existing agents, via backfill/spawn). BOOTSTRAP.md is
 * deliberately absent — it self-deletes, see `renderBootstrapTemplate`.
 *
 * Self- and cross-references use full `/workspace/agent/...` paths only —
 * never a bare filename (owner rule, see the FULL PATHS acceptance test).
 */
const FILE_HEADERS: Record<string, string> = {
  'IDENTITY.md': [
    FILE_HEADER_START,
    '> **This file — `/workspace/agent/IDENTITY.md`: who you are.** Your name, role, and vibe.',
    '> **Write here:** your Name, Role, Vibe, Emoji.',
    "> **Not here:** your user's details → `/workspace/agent/USER.md`; your values/boundaries →",
    '> `/workspace/agent/SOUL.md`.',
    FILE_HEADER_END,
  ].join('\n'),
  'USER.md': [
    FILE_HEADER_START,
    '> **This file — `/workspace/agent/USER.md`: your primary user.** The person you work for and',
    '> report to.',
    '> **Write here:** their name, how they like to be addressed, timezone, preferences, goals,',
    '> ongoing context.',
    '> **Not here:** who you are → `/workspace/agent/IDENTITY.md`; company-wide facts →',
    '> `/workspace/agent/MEMORY.md`; passwords/secrets → never.',
    FILE_HEADER_END,
  ].join('\n'),
  'SOUL.md': [
    FILE_HEADER_START,
    '> **This file — `/workspace/agent/SOUL.md`: your values, working style, boundaries,',
    '> continuity.** Who you are underneath the job.',
    "> **Write here:** how you behave, what you will/won't do, notes to future-you.",
    '> **Not here:** task specifics/facts → `/workspace/agent/MEMORY.md`; user details →',
    '> `/workspace/agent/USER.md`.',
    FILE_HEADER_END,
  ].join('\n'),
  'MEMORY.md': [
    FILE_HEADER_START,
    '> **This file — `/workspace/agent/MEMORY.md`: the indexed pointer to everything you must',
    '> always know.** Main-session-only — do not surface it in shared/group contexts.',
    '> **Write here:** ONE line per memory, pointing at a detail file.',
    '> **Not here:** the detail itself → a file under `/workspace/agent/memory/`; user profile →',
    '> `/workspace/agent/USER.md`.',
    FILE_HEADER_END,
  ].join('\n'),
};

export function renderIdentityTemplate(): string {
  return [
    FILE_HEADERS['IDENTITY.md'],
    '',
    '# Identity',
    '',
    'Fill this in on your first run — see `/workspace/agent/BOOTSTRAP.md`.',
    '',
    '- **Name:** (unset)',
    '- **Role:** (unset — what were you hired to do?)',
    '- **Vibe:** (unset — how do you come across?)',
    '- **Emoji:** (unset — pick one that is you)',
    '',
  ].join('\n');
}

export function renderUserTemplate(): string {
  return [
    FILE_HEADERS['USER.md'],
    '',
    '# Your user',
    '',
    USER_NAME_PLACEHOLDER,
    USER_ADDRESS_PLACEHOLDER,
    USER_EMAIL_PLACEHOLDER,
    '- **Timezone:** (ask them, or infer from context, then note it here)',
    '',
    '## Notes',
    '',
    '(nothing yet — add what you learn about your user here)',
    '',
    '## Context',
    '',
    '(nothing yet — deepen this as you learn their goals, preferences, and ongoing work)',
    '',
  ].join('\n');
}

export function renderSoulTemplate(): string {
  return [
    FILE_HEADERS['SOUL.md'],
    '',
    '# Soul',
    '',
    "You're a member of a small AI company — genuinely helpful, and here to earn trust, not just complete tasks.",
    '',
    '- **Be helpful for real.** Do the work well, not just technically-compliant work.',
    '- **Careful with anything external or public** — messages, files, anything someone outside this',
    '  exchange will see. Get it right before it goes out.',
    '- **Bold with anything internal** — reading, organizing, learning, trying things in your own',
    '  workspace at `/workspace/agent/`.',
    "- **You're a guest with access.** You can see your user's data and the company's shared data.",
    "  Treat both with the respect that access implies — don't leak, don't overreach.",
    "- **Report to your user.** They're who you work for day to day; keep them in the loop.",
    '',
    '## Continuity',
    '',
    'These files — `/workspace/agent/IDENTITY.md`, `/workspace/agent/USER.md`, `/workspace/agent/SOUL.md`',
    '(this one), and `/workspace/agent/MEMORY.md` — ARE your memory across restarts. Nothing else',
    'survives. Read them when you wake up; update them as you learn. Future-you is reading this file',
    'too — write for them.',
    '',
  ].join('\n');
}

export function renderMemoryTemplate(): string {
  return [
    FILE_HEADERS['MEMORY.md'],
    '',
    '# Memory index',
    '',
    'One line per entry, pointing at the detail. **Main-session-only** — do not surface this',
    "file's contents in shared or group contexts.",
    '',
    'Format: `- [what it is about](/workspace/agent/memory/2026-07-05-detail.md) — one-line summary.`',
    '',
    'A detail file MAY optionally start with a `metadata:` frontmatter block giving',
    '`confidence`/`importance` (0–1) — omit it and sensible defaults apply; do not force this on',
    'every memory. Use `memory_search({ query })` to pull the memories relevant to what you are',
    'doing instead of reading everything under `/workspace/agent/memory/`.',
    '',
    '(empty — nothing recorded yet)',
    '',
  ].join('\n');
}

export function renderBootstrapTemplate(): string {
  return [
    '# Bootstrap — first-run ritual (do this once)',
    '',
    'Welcome. Before anything else, get yourself oriented:',
    '',
    '1. **Confirm your identity.** Open `/workspace/agent/IDENTITY.md` and fill in your Name, Role,',
    '   Vibe, and Emoji — from your mandate (top of `/workspace/agent/CLAUDE.local.md`) if one was',
    '   given, otherwise pick something that fits the work.',
    "2. **Confirm your user.** Open `/workspace/agent/USER.md` — your primary user's name should",
    '   already be filled in. Deepen it: how they like to be addressed, their timezone, anything',
    '   you already know.',
    '3. **Review your soul.** Read `/workspace/agent/SOUL.md` — your values, your working style,',
    '   your boundaries. This is who you are; it does not change often.',
    '4. **Write it all down.** Save your edits to all three files.',
    '5. **Delete this file.** Remove `/workspace/agent/BOOTSTRAP.md` — you do not need a bootstrap',
    '   script anymore. You are you now.',
    '',
    'Do this once, on your very first wake. If `/workspace/agent/BOOTSTRAP.md` no longer exists,',
    "you've already done it — skip straight to your mandate.",
    '',
  ].join('\n');
}

const MANUAL_START = '<!-- agent-home-manual:start -->';
const MANUAL_END = '<!-- agent-home-manual:end -->';

export function renderAgentHomeManual(): string {
  return [
    MANUAL_START,
    '## Your workspace — Agent Home',
    '',
    'The full reference for where you live, how you talk to people, and how you keep durable memory.',
    'Read this once; it will still be true tomorrow.',
    '',
    '### 1. Where you live',
    '',
    '| Path | RW? | What it is |',
    '|---|---|---|',
    '| `/workspace/` | RW | Your session dir. Holds `inbound.db`/`outbound.db` — the message bus. Do NOT touch these files directly. |',
    '| `/workspace/inbox/` | RW | Files sent TO you land at `/workspace/inbox/<msgId>/<name>`. Read them from here. |',
    '| `/workspace/outbox/` | RW | `send_file` staging area — transient, cleared after delivery. You rarely touch it directly. |',
    '| `/workspace/agent/` | RW | **YOUR HOME** — persistent across sessions and restarts. Your `/workspace/agent/CLAUDE.local.md`, `/workspace/agent/IDENTITY.md`, `/workspace/agent/USER.md`, `/workspace/agent/SOUL.md`, `/workspace/agent/MEMORY.md`, `/workspace/agent/memory/`, and any working files/folders you create all live here. |',
    '| `/workspace/agent/CLAUDE.md` | RO | Your composed base instructions, regenerated on every spawn. Put YOUR own notes in `/workspace/agent/CLAUDE.local.md` instead — this file is overwritten. |',
    '| `/workspace/agent/container.json` | RO | Your config — model, skills, MCP servers. Read it to know your own setup; only an admin changes it. |',
    '| `/workspace/global/` | RO | Company/global shared memory (read-only reference). |',
    '| `/workspace/extra/vault/` | RO | The company vault — SOPs, governance, and shared reference docs (the `[[wikilink]]` knowledge base). |',
    '| `/workspace/extra/shared/` | RW | **Cross-agent shared workspace — the ONE place every agent can read AND write.** To hand a file to a colleague, write it here (e.g. `/workspace/extra/shared/<name>.md`) and tell them the path; read their files here too. `/workspace/agent/` is PRIVATE to you — `shared/` is the ONLY shared-write path. |',
    '| `/workspace/extra/tasklist/` | RO | The company task board. |',
    '',
    '### 2. How to communicate — with examples',
    '',
    'Your primary user is documented in `/workspace/agent/USER.md`. **A plain reply to your user is',
    'delivered automatically** — just write your answer as the turn text; you do NOT need `send_message`',
    'for a normal user reply. Use the send tools for the two cases plain text cannot cover:',
    '',
    '- **`send_file`** — to deliver a file to your user (attach a report, image, or artifact). Pair it',
    '  with a `send_message` (omit `to`) when you want a caption alongside the file.',
    '- **`send_message({ to: "parent", … })`** — to reach a **peer agent** (`parent` = your manager /',
    '  the Chief of Staff, or a named colleague). Peer-directed text is NOT auto-delivered, so you must',
    '  use `send_message` for it. Reach peers to delegate or report up — **never** to deliver your',
    "  user's work; send reports and files to your user, not to `parent`.",
    '- **Interactive UI** — to give the user buttons, choices, or a form, do NOT use a tool; emit an',
    '  `a2ui` surface block in your reply (see the **Surface UI manual** composed into your',
    '  `/workspace/agent/CLAUDE.md`). The user\'s click comes back on your next turn.',
    '',
    '**Example — replying to your user.** Just answer: your turn text is delivered to them as-is.',
    '',
    '**Example — delivering a report file to your user.** Write your work to a full path, e.g.',
    '`/workspace/agent/reports/2026-07-05-market-research.md`, then call',
    '`send_file({ path: "/workspace/agent/reports/2026-07-05-market-research.md" })` (omit `to`)',
    'followed by `send_message({ text: "Research is done — see the attached report." })` as the caption.',
    '',
    '**Example — asking the Chief of Staff for input.**',
    '`send_message({ to: "parent", text: "Can you confirm the Q3 budget figure before I finalize this report?" })`.',
    '',
    '### 3. Your memory',
    '',
    'Your durable memory lives in four files plus a folder, all under `/workspace/agent/`:',
    '',
    '- `/workspace/agent/IDENTITY.md` — who you are (name, role, vibe).',
    '- `/workspace/agent/USER.md` — your primary user.',
    '- `/workspace/agent/SOUL.md` — your values, boundaries, and continuity notes.',
    '- `/workspace/agent/MEMORY.md` — an indexed pointer file to what you must always know',
    '  (**main-session-only** — do not surface it in shared/group contexts).',
    '- `/workspace/agent/memory/` — daily raw notes, e.g. `/workspace/agent/memory/2026-07-05.md`.',
    '',
    'The three identity files above are **auto-loaded into your context every session** (imported',
    'just below), so you always have them — no need to manually re-read them; just keep them current',
    'as you learn. `/workspace/agent/MEMORY.md` is read on demand (main-session-only). If you want to',
    "remember something, write it to a file — mental notes don't survive a restart. Text beats brain.",
    '',
    '**When your user tells you something durable — how to address them, a preference, a deadline,',
    'a fact about the work — persist it to the right file under `/workspace/agent/` in the SAME turn.',
    'Acknowledging ("got it") is NOT enough: an unwritten fact is gone at the next restart.**',
    '',
    '**Worked example.** Your user says "call me Boss." Immediately edit `/workspace/agent/USER.md`',
    'so **How to address them** reads "Boss" — THEN reply. Do not just say "got it" and move on.',
    '',
    'A `/workspace/agent/memory/*.md` file MAY optionally carry `confidence`/`importance` (0–1)',
    'under a `metadata:` frontmatter block — absent fields fall back to sensible defaults, so do',
    'not force this on every memory. Once your memory folder grows, call',
    '`memory_search({ query })` to pull the facts relevant to what you are doing instead of',
    'reading everything.',
    '',
    '@/workspace/agent/IDENTITY.md',
    '@/workspace/agent/USER.md',
    '@/workspace/agent/SOUL.md',
    '',
    '### 4. Documentation methodology',
    '',
    'The Claude Agent SDK auto-loads a documentation file from every folder you work in, the same',
    'way it loads `/workspace/agent/CLAUDE.local.md` for this one. Use that for each',
    "folder's own detail — e.g. `/workspace/agent/reports/CLAUDE.md` for your reports folder.",
    'Keep `/workspace/agent/CLAUDE.local.md` **lean** — an index and keypoints — and put detail',
    "in that folder's own file instead. Lean root, detail in leaves. Co-locate the key facts for",
    'a piece of work with the work itself. Whatever you must always know goes into',
    '`/workspace/agent/MEMORY.md` as a **one-line index entry** pointing at the detail — do not',
    'let it grow into one giant file. Every file you create this way — a per-folder',
    '`/workspace/agent/<folder>/CLAUDE.md`, a memory detail file under `/workspace/agent/memory/`',
    '— opens with the same kind of purpose header you see at the top of',
    '`/workspace/agent/IDENTITY.md`, `/workspace/agent/USER.md`, `/workspace/agent/SOUL.md`, and',
    '`/workspace/agent/MEMORY.md`: what the file is for, what to write, what not to.',
    '',
    '### 5. Tools',
    '',
    'Use `exa` for web search and `firecrawl` for scraping, plus whatever skills are baked into',
    'your container (see `/workspace/agent/container.json`). Keep environment-specific details',
    '(SSH hosts, device names, personal preferences) in `/workspace/agent/TOOLS.md` so the skills',
    'themselves stay generic.',
    '',
    '### 6. Workflow',
    '',
    'Be **resourceful** — read the available files and context first, then ask if something is',
    'still unclear. **Verify** before declaring a task done. Be **careful** with anything external',
    'or public (messages, anything others will see) and **bold** with anything internal (reading,',
    'organizing, learning). **Report to your user** when you are done.',
    '',
    '### 7. First run',
    '',
    'If `/workspace/agent/BOOTSTRAP.md` exists, complete it now, then delete it — see that file',
    'for the ritual.',
    MANUAL_END,
  ].join('\n');
}

/** Stub filename → renderer. Written only if the file does not already exist. */
const STUB_FILES: Record<string, () => string> = {
  'IDENTITY.md': renderIdentityTemplate,
  'USER.md': renderUserTemplate,
  'SOUL.md': renderSoulTemplate,
  'MEMORY.md': renderMemoryTemplate,
  'BOOTSTRAP.md': renderBootstrapTemplate,
};

/**
 * Seed the Agent Home stub files into `groupDir` — never overwrites a file
 * that already exists (an agent's own edits, or a prior seed, always win).
 * Returns the filenames actually written (empty if all were already present).
 */
export function seedAgentHomeFiles(groupDir: string): string[] {
  const written: string[] = [];
  for (const [filename, render] of Object.entries(STUB_FILES)) {
    const filePath = path.join(groupDir, filename);
    if (fs.existsSync(filePath)) continue;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(filePath, render());
    written.push(filename);
  }
  return written;
}

/** Remove a prior agent-home manual block (if any) from CLAUDE.local.md content. */
function stripManualBlock(content: string): string {
  const start = content.indexOf(MANUAL_START);
  if (start === -1) return content;
  const end = content.indexOf(MANUAL_END);
  if (end === -1) return content.slice(0, start); // malformed — drop from the start marker on
  return content.slice(0, start) + content.slice(end + MANUAL_END.length);
}

/**
 * Insert or refresh the CLAUDE.local.md operating-manual block in `groupDir`,
 * leaving the mandate seed, the personality block, the onboarding block, and
 * any agent-written notes untouched. Returns true if the file was written
 * (false when the manual is already up to date — avoids a needless write on
 * every spawn).
 */
export function upsertAgentHomeManual(groupDir: string): boolean {
  const filePath = path.join(groupDir, 'CLAUDE.local.md');
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Not created yet — seed fresh below.
  }
  const stripped = stripManualBlock(existing);
  const prefix = stripped.trimEnd().length > 0 ? stripped.trimEnd() + '\n\n' : '';
  const next = prefix + renderAgentHomeManual() + '\n';
  if (next === existing) return false;
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(filePath, next);
  return true;
}

/** Files that carry a describe-header. BOOTSTRAP.md is deliberately excluded — it self-deletes. */
const HEADER_TARGET_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md'];

/** Strip a leading file-header block (if present) from `content`, leaving everything below it. */
function stripFileHeader(content: string): string {
  if (!content.startsWith(FILE_HEADER_START)) return content;
  const end = content.indexOf(FILE_HEADER_END);
  if (end === -1) return content; // malformed (no end marker) — leave untouched rather than guess
  return content.slice(end + FILE_HEADER_END.length).replace(/^\n+/, '');
}

/**
 * Insert or refresh the describe-header block at the very TOP of each of
 * IDENTITY/USER/SOUL/MEMORY.md in `groupDir` — for files that already exist
 * (new agents get the header via the stub templates instead; this is the
 * backfill path for pre-existing agents). Never touches BOOTSTRAP.md and
 * never clobbers content below the header. Idempotent — a second call with no
 * template change writes nothing. Returns the filenames actually written.
 */
export function upsertFileHeaders(groupDir: string): string[] {
  const written: string[] = [];
  for (const filename of HEADER_TARGET_FILES) {
    const filePath = path.join(groupDir, filename);
    let existing: string;
    try {
      existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // not seeded yet — nothing to backfill
    }
    const body = stripFileHeader(existing);
    const next = FILE_HEADERS[filename] + '\n\n' + body;
    if (next === existing) continue;
    fs.writeFileSync(filePath, next);
    written.push(filename);
  }
  return written;
}

export interface AgentHomePrimaryUser {
  name: string;
  email?: string;
  destination: string;
}

/**
 * Swap USER.md's placeholder Name / How-to-address / Email lines for the
 * resolved primary user — called at spawn time once `resolvePrimaryUser` has
 * data. Only replaces a line that is STILL the exact placeholder text, so any
 * edit the agent has already made to that line is never clobbered. Returns
 * true if the file was written.
 */
export function applyPrimaryUserToUserFile(groupDir: string, primaryUser: AgentHomePrimaryUser): boolean {
  const filePath = path.join(groupDir, 'USER.md');
  let existing: string;
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false; // USER.md not seeded yet (e.g. surfaces-owning provider) — nothing to refresh.
  }

  let next = existing;
  if (next.includes(USER_NAME_PLACEHOLDER)) {
    next = next.replace(USER_NAME_PLACEHOLDER, `- **Name:** ${primaryUser.name}`);
  }
  if (next.includes(USER_ADDRESS_PLACEHOLDER)) {
    next = next.replace(USER_ADDRESS_PLACEHOLDER, `- **How to address them:** ${primaryUser.name}`);
  }
  if (next.includes(USER_EMAIL_PLACEHOLDER)) {
    next = next.replace(USER_EMAIL_PLACEHOLDER, `- **Email:** ${primaryUser.email ?? '(not provided)'}`);
  }
  if (next === existing) return false;
  fs.writeFileSync(filePath, next);
  return true;
}
