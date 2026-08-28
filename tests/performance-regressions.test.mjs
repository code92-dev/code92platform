import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('anonymous auth returns before calling get_me', async () => {
  const source = await read('lib/auth.ts');
  const rpcIndex = source.indexOf("rpc('get_me')");

  assert.ok(rpcIndex > 0);
  assert.ok(source.indexOf("has('insforge_access_token')") < rpcIndex);
  assert.ok(source.indexOf("has('insforge_refresh_token')") < rpcIndex);
  assert.ok(source.indexOf('return null;', source.indexOf('const getMe')) < rpcIndex);
});

test('only the visible notification bell refreshes on mount or navigation', async () => {
  const source = await read('components/notifications/NotificationBell.tsx');
  const pollingStart = source.indexOf('useEffect(() => {');
  const pollingEnd = source.indexOf('function markAllRead');
  const pollingSource = source.slice(pollingStart, pollingEnd);

  assert.match(pollingSource, /triggerRef\.current\.getClientRects\(\)\.length === 0/);
  assert.match(pollingSource, /window\.addEventListener\('resize', tick\)/);
  assert.equal((pollingSource.match(/refresh\(\)\.catch/g) ?? []).length, 1);
  assert.match(pollingSource, /\[pathname, refresh\]/);
});

test('tasks starts auth, translations, and initial data in one wave', async () => {
  const source = await read('app/[locale]/tasks/page.tsx');
  const waveStart = source.indexOf('const [{user}, t,');
  const waveEnd = source.indexOf('const taskRows');
  const wave = source.slice(waveStart, waveEnd);

  assert.match(wave, /await Promise\.all\(\[/);
  assert.match(wave, /requireActiveMember\(\)/);
  assert.match(wave, /getTranslations\('tasks'\)/);
  assert.match(wave, /Promise\.all\(\[/);
});

test('product detail starts auth, translations, and product lookup together', async () => {
  const source = await read('app/[locale]/products/[id]/page.tsx');
  const firstWaveStart = source.indexOf('const [{user, member},');
  const firstWaveEnd = source.indexOf('if (!product)');
  const firstWave = source.slice(firstWaveStart, firstWaveEnd);

  assert.match(firstWave, /await Promise\.all\(\[/);
  assert.match(firstWave, /requireActiveMember\(\)/);
  assert.match(firstWave, /getTranslations\('products'\)/);
  assert.match(firstWave, /from\('products'\)/);

  const dataWaveStart = source.indexOf('const [\n    {data: members}');
  const dataWaveEnd = source.indexOf('const taskIds');
  const dataWave = source.slice(dataWaveStart, dataWaveEnd);

  assert.match(dataWave, /rpc\('github_is_configured'\)/);
  assert.match(dataWave, /from\('release_overview'\)/);
  assert.equal((dataWave.match(/await Promise\.all\(\[/g) ?? []).length, 1);
});

test('channel attachment hydration is bounded to the visible message page', async () => {
  const source = await read('lib/actions/channels.ts');
  const queryStart = source.indexOf(".from('knowledge_items')");
  const queryEnd = source.indexOf("return {", queryStart);
  const query = source.slice(queryStart, queryEnd);

  assert.match(query, /\.in\('source_message_id', messageIds\)/);
  assert.match(query, /\.limit\(messageIds\.length \* MAX_MESSAGE_ATTACHMENTS\)/);
});

test('agent product knowledge lookup caps link identifiers before the IN query', async () => {
  const source = await read('functions/agent-runtime.ts');
  const queryStart = source.lastIndexOf("from('knowledge_item_products')");
  const queryEnd = source.indexOf('const ids', queryStart);
  assert.match(source.slice(queryStart, queryEnd), /\.limit\(500\)/);
});
