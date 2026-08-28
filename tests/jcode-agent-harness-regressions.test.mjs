import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('jcode queueing keeps DMs agent-free and snapshots the selected runtime', async () => {
  const migration = await read(
    'migrations/20260826130000_add-jcode-agent-harness.sql'
  );

  assert.match(migration, /NEW\.kind <> 'human'[\s\S]*kind = 'dm'[\s\S]*RETURN NEW/);
  assert.match(migration, /WHERE agents\.handle = v_handle AND enabled AND archived_at IS NULL/);
  assert.match(
    migration,
    /INSERT INTO public\.agent_runs \([\s\S]*runtime[\s\S]*VALUES \(ag\.user_id,[\s\S]*ag\.runtime/
  );
});

test('runner leases and capabilities remain unavailable to browser roles', async () => {
  const migration = await read(
    'migrations/20260826130000_add-jcode-agent-harness.sql'
  );
  const runtime = await read('functions/agent-runtime.ts');

  for (const signature of [
    'claim_jcode_agent_run\\(UUID, TEXT, INTEGER\\)',
    'agent_run_lease_is_valid\\(UUID, TEXT\\)',
    'agent_jcode_capability_is_valid\\(UUID, TEXT\\)'
  ]) {
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature}[\\s\\S]*FROM PUBLIC, anon, authenticated`)
    );
  }

  assert.match(runtime, /runner authentication failed/);
  assert.match(runtime, /X-Agent-Run-Token/);
  assert.match(runtime, /agent_jcode_capability_is_valid/);
  assert.match(runtime, /if \(body\?\.action === 'tool'\)[\s\S]*const runner = runnerId\(req\)/);
});

test('repository patches stay docs-only and commit under the approver authority', async () => {
  const githubSync = await read('functions/github-sync.ts');
  const actions = await read('lib/actions/agents.ts');

  assert.match(githubSync, /const AGENT_PATCH_ROOTS = \['docs\/'\]/);
  assert.match(githubSync, /path\.startsWith\('\/'\)[\s\S]*path\.includes\('\.\.'\)[\s\S]*path\.includes\('\\\\'\)/);
  assert.match(githubSync, /proposal\.decided_by !== caller\.userId/);
  assert.match(githubSync, /const product = await requireProduct\(admin, caller, proposal\.product_id\)/);
  assert.match(githubSync, /commitFiles\(token, product\.github_repo, branch, changes, message\)/);
  assert.match(githubSync, /action: 'apply_agent_patch'[\s\S]*actor_id: caller\.userId/);

  assert.match(actions, /decision === 'approve'[\s\S]*applyApprovedPatch/);
  assert.match(actions, /record_agent_proposal_commit/);
  assert.match(actions, /if \(commitSha && recordError\)[\s\S]*commitUnrecorded/);
});

test('autonomous actions remain a strict non-repository subset with no client execute grant', async () => {
  const migration = await read(
    'migrations/20260827110000_add-autonomous-agent-actions.sql'
  );
  const runtime = await read('functions/agent-runtime.ts');

  assert.match(migration, /autonomous_actions <@ allowed_actions/);
  assert.doesNotMatch(
    migration.match(/ADD COLUMN autonomous_actions[\s\S]*?;\n/)?.[0] ?? '',
    /repo_patch|lifecycle_advance/
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.apply_agent_proposal_autonomously\(UUID\) FROM authenticated/
  );
  assert.match(runtime, /allowed\.includes\(action\)[\s\S]*AUTONOMOUS_ACTIONS/);
  assert.match(runtime, /delete payload\.waiver_reason[\s\S]*delete payload\.self_approved/);
});

test('channel attachment creation re-derives authorship and immutable provenance', async () => {
  const migration = await read(
    'migrations/20260827100000_add-channel-attachments.sql'
  );

  assert.match(migration, /source_message_id UUID[\s\S]*REFERENCES public\.messages\(id\) ON DELETE CASCADE/);
  assert.match(migration, /OLD\.origin = 'channel'[\s\S]*source of a channel attachment is immutable/);
  assert.match(migration, /IF NOT public\.is_active_member\(\)/);
  assert.match(migration, /msg\.author_id IS DISTINCT FROM actor/);
  assert.match(migration, /msg\.deleted_at IS NOT NULL/);
  assert.match(migration, /IF seen > 8/);
  assert.match(migration, /public\.is_allowed_attachment_type/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.attach_files_to_message\(UUID, JSONB\) FROM PUBLIC/);
});

test('the forward fix rewrites and verifies every broken knowledge link function', async () => {
  const migration = await read(
    'migrations/20260828140000_fix-knowledge-item-products-column.sql'
  );

  for (const name of [
    'decide_agent_proposal',
    'apply_agent_proposal_autonomously',
    'attach_files_to_message'
  ]) {
    assert.match(migration, new RegExp(`'${name}'`));
  }
  assert.match(
    migration,
    /knowledge_item_products \(knowledge_item_id, product_id\)'[\s\S]*knowledge_item_products \(item_id, product_id\)'/
  );
  assert.match(migration, /IF broken THEN[\s\S]*RAISE EXCEPTION/);
});

test('channel attachment visibility follows the owning message, including link tables', async () => {
  const migration = await read(
    'migrations/20260828150000_harden-channel-attachment-privacy.sql'
  );

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.can_read_knowledge_item/);
  assert.match(migration, /ki\.origin <> 'channel'[\s\S]*public\.can_read_channel\(m\.channel_id\)/);
  assert.match(migration, /DROP POLICY "active members read knowledge items"/);
  assert.match(migration, /USING \(public\.can_read_knowledge_item\(id\)\)/);
  assert.match(migration, /knowledge_item_tags[\s\S]*USING \(public\.can_read_knowledge_item\(item_id\)\)/);
  assert.match(migration, /knowledge_item_products[\s\S]*USING \(public\.can_read_knowledge_item\(item_id\)\)/);
});

test('autonomous execution cannot trust model-selected product or task identifiers', async () => {
  const migration = await read(
    'migrations/20260828160000_scope-autonomous-agent-actions.sql'
  );

  assert.match(migration, /task_create[\s\S]*product_id, parent_task_id/);
  assert.match(migration, /VALUES \([\s\S]*prop\.product_id,[\s\S]*payload ->> 'parent_task_id'/);
  assert.match(migration, /WHERE id = \(payload ->> 'task_id'\)::UUID[\s\S]*product_id = prop\.product_id/);
  assert.match(migration, /status_update[\s\S]*VALUES \([\s\S]*prop\.product_id/);
  assert.match(migration, /prop\.product_id IS NULL[\s\S]*requires a product-bound channel/);
});

test('knowledge notes remain proposal-only after the autonomous-action hardening', async () => {
  const migration = await read(
    'migrations/20260828170000_require-approval-for-knowledge-notes.sql'
  );
  const runtime = await read('functions/agent-runtime.ts');
  const agents = await read('lib/agents.ts');

  assert.match(migration, /array_remove\(autonomous_actions, 'knowledge_note'\)/);
  assert.match(migration, /agents_autonomous_actions_check/);
  assert.match(migration, /'task_create', 'task_update', 'status_update'/);
  assert.match(runtime, /const AUTONOMOUS_ACTIONS = \[[\s\S]*'task_create',[\s\S]*'status_update'/);
  assert.doesNotMatch(runtime.match(/const AUTONOMOUS_ACTIONS = \[[\s\S]*?\];/)?.[0] ?? '', /knowledge_note/);
  assert.doesNotMatch(agents.match(/export const AUTONOMOUS_ACTIONS = \[[\s\S]*?\] as const/)?.[0] ?? '', /knowledge_note/);
});

test('the operator harness has no shell and final replies redact model credentials', async () => {
  const driver = await read('services/agent-runner/jcode-driver.mjs');
  const runtime = await read('functions/agent-runtime.ts');
  const stream = await read('components/channels/MessageStream.tsx');

  assert.match(driver, /OPERATOR_TOOLS = \['read', 'write', 'edit', 'apply_patch', 'grep', 'glob', 'ls'\]/);
  assert.doesNotMatch(driver, /OPERATOR_TOOLS = \[[^\]]*['"]bash['"]/);
  assert.match(runtime, /function redactReply\(value: string\)/);
  assert.match(runtime, /const reply = redactReply\(parsed\.reply\)/);
  assert.match(stream, /let stored: Awaited<ReturnType<typeof uploadMessageAttachments>> = \[\]/);
  assert.match(stream, /stored\.map\(\(file\) => removeKnowledgeFile\(file\.key\)\)/);
});
