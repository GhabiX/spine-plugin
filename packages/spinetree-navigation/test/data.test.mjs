import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeSpineRuntime } from '@spinejit/spine-sdk/node';
import { createNavigationData } from '../dist/data.js';

async function fixture(epoch = 0) {
  const runtime = createNodeSpineRuntime({ thread: 'original', epoch, features: ['jit', 'spawn'] });
  const entries = [];
  const inputs = [];
  let boundary = 0;
  let serial = 0;
  let projection;
  let thread = 'original';
  const add = value => { const entry = { id: `entry-${serial++}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...value }; entries.push(entry); return entry; };
  const source = async (role, content) => { const character = { type: 'message', boundary: boundary++, role, content }; inputs.push({ type: 'source', character }); return runtime.client.execute({ type: 'observe_sources', characters: [character] }); };
  const archive = record => { inputs.push({ type: 'archive', record }); return add({ type: 'custom', customType: 'spine.archive.v1', data: { schema: 'spine-plugin/pi/v1', durabilityId: record.record.commit_id?.value ?? record.record.attempt_id.value, record } }); };
  add({ type: 'message', message: { role: 'user', content: 'Start test', timestamp: 1 } });
  await source('user', 'Start test');
  async function step(operations, terminal = 'completed', succeeded = true) {
    const started = await runtime.client.execute({ type: 'begin_sampling' });
    archive(started.record);
    const calls = operations.map((operation, i) => ({ type: 'toolCall', id: `call-${serial}-${i}`, name: `spine_${operation.type}`, arguments: operation }));
    const entry = add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'before call' }, ...calls], timestamp: serial } });
    await source('assistant', JSON.stringify(calls));
    for (let i = 0; i < operations.length; i++) {
      const key = calls[i].id;
      await runtime.client.execute({ type: 'register_execution', key });
      await runtime.client.execute({ type: 'stage_execution', key, execution_ref: key, operation: operations[i] });
      await runtime.client.execute({ type: 'finish_execution', key, succeeded });
    }
    const prepared = await runtime.client.execute({ type: 'prepare_finish', terminal });
    if (prepared.type === 'finish_prepared') {
      archive(prepared.record);
      const installed = await runtime.client.execute({ type: 'install_prepared', transaction_id: prepared.transaction_id });
      projection = installed.projection;
    } else projection = (await runtime.client.execute({ type: 'preview' })).projection;
    return { entry, calls };
  }
  async function compact() {
    const compactBoundary = boundary++;
    const barrier = { schema: 'spine.compact.barrier.v1', thread, previous_epoch: epoch, next_epoch: epoch + 1, boundary: compactBoundary, replacement_boundaries: [boundary++] };
    const result = await runtime.client.execute({ type: 'compact', barrier });
    projection = result.projection;
    inputs.push({ type: 'compact', barrier });
    epoch++;
    add({ type: 'custom', customType: 'spine.compact.v1', data: { schema: 'spine-plugin/pi/v1', barrier, replacementMessages: [] } });
    const entry = add({ type: 'compaction', summary: 'Compacted history', firstKeptEntryId: entries[0].id, tokensBefore: 20, fromHook: true });
    return entry;
  }
  // A spawned child's result enters as an external input before the next sampling.
  async function arrive(summary, outcome = 'completed') {
    const birth = projection.nodes.find(node => node.kind === 'Spawn' && node.summary === summary);
    const arrival = { producer: birth.id, outcome, ...(outcome === 'completed' ? { memory: `${summary} returned` } : { diagnostic: 'test error' }) };
    const character = { type: 'arrival', boundary: boundary++, arrival };
    inputs.push({ type: 'source', character });
    add({ type: 'custom_message', customType: 'spine.arrival', content: summary, display: true, details: { schema: 'spine.pi.arrival/v1', arrival } });
    await runtime.client.execute({ type: 'observe_sources', characters: [character] });
  }
  return { runtime, entries, inputs, step, compact, arrive, async fork() { thread = 'fork'; await runtime.client.execute({ type: 'continue_namespace', thread }); }, data() { return createNavigationData({ sessionId: thread, generation: 1, nodes: projection.nodes, cursor: projection.cursor }); }, get projection() { return projection; } };
}

const spawn = (summary) => ({ type: 'spawn', tasks: [summary, `${summary}-peer`].map(summary => ({ summary, prompt: `${summary} prompt` })) });

test('real runtime Open/Next/Spawn/compact map to navigable nodes and memory', async () => {
  const f = await fixture(17);
  try {
    await f.step([{ type: 'open', summary: 'research' }]);
    await f.step([{ type: 'next', next_summary: 'implement', closed_memory: 'Research findings' }]);
    await f.step([spawn('a')]);
    await f.arrive('a');
    await f.arrive('a-peer');
    await f.step([spawn('b')]);
    assert.equal(f.data().nodes.find(n => n.summary === 'b').spawn, 'pending');
    assert.match(f.data().memoryText(f.data().nodes.find(n => n.summary === 'b').id), /running/);
    await f.arrive('b', 'errored');
    await f.arrive('b-peer');
    await f.step([]);
    await f.compact();
    await f.fork();
    await f.step([{ type: 'open', summary: 'after compact' }]);
    const data = f.data();
    assert.deepEqual(data.nodes.filter(n => n.kind === 'Task').map(n => n.summary), ['research', 'implement', 'after compact']);
    assert.deepEqual(data.nodes.filter(n => n.kind === 'Spawn').map(n => [n.summary, n.spawn]), [['a', { arrived: 'completed' }], ['a-peer', { arrived: 'completed' }], ['b', { arrived: 'errored' }], ['b-peer', { arrived: 'completed' }]]);
    assert.deepEqual(data.memorySections('1.1'), ['Research findings']);
    assert.equal(data.memoryText('1.1'), 'Research findings');
    const b = data.nodes.find(n => n.summary === 'b');
    assert.match(data.memoryText(b.id), /errored/);
  } finally { f.runtime.dispose(); }
});

test('parent own memory excludes descendant summaries; full memory preserves slots and binary attachments stay hidden', async () => {
  const f = await fixture();
  try {
    await f.step([{ type: 'open', summary: 'parent' }]);
    await f.step([{ type: 'open', summary: 'child' }]);
    await f.step([{ type: 'close', memory: 'child conclusion' }]);
    await f.step([{ type: 'close', memory: 'parent conclusion' }]);
    const data = f.data();
    assert.deepEqual(data.memorySections('1.1'), ['parent conclusion']);
    assert.equal(data.memoryText('1.1'), 'parent conclusion');
    assert.match(data.memoryText('1.1', true), /child conclusion[\s\S]*parent conclusion/);
  } finally { f.runtime.dispose(); }
});

test('own memory keeps multiple summaries as lazy sections in slot order', () => {
  const snapshot = {
    cursor: [1, 1],
    nodes: [{
      id: [1, 1], parent: [1], children: [], kind: 'Task', status: 'Closed',
      summary: 'multiple summaries', start: 0, end: 3,
      memory: [
        { Summary: { owner_node: [1, 1], body: 'first summary', source: { start: 0, end: 1 } } },
        { Summary: { owner_node: [1, 1], body: 'second summary', source: { start: 2, end: 3 } } },
      ],
    }],
  };
  const data = createNavigationData(snapshot);
  assert.deepEqual(data.memorySections('1.1'), ['first summary', 'second summary']);
});

test('uncommitted failed open does not overwrite published nodes', async () => {
  const f = await fixture();
  try {
    await f.step([{ type: 'open', summary: 'kept' }]);
    await f.step([{ type: 'open', summary: 'failed' }], 'failed', false);
    const data = f.data();
    assert.equal(data.nodes.some(n => n.summary === 'kept'), true);
    assert.equal(data.nodes.some(n => n.summary === 'failed'), false);
  } finally { f.runtime.dispose(); }
});

test('namespace continuation preserves the visible node projection', async () => {
  const f = await fixture();
  try {
    await f.step([{ type: 'open', summary: 'old namespace' }]);
    await f.fork();
    await f.step([{ type: 'next', next_summary: 'new namespace', closed_memory: 'retained' }], 'cancelled');
    assert.equal(f.data().nodes.some(n => n.summary === 'old namespace'), true);
    assert.equal(f.data().nodes.some(n => n.summary === 'new namespace'), true);
  } finally { f.runtime.dispose(); }
});

test('compact publication preserves nodes without reading session history', async () => {
  const f = await fixture();
  try {
    await f.step([{ type: 'open', summary: 'old' }]);
    await f.compact();
    const data = createNavigationData({ sessionId: 'original', generation: 1, nodes: f.projection.nodes, cursor: f.projection.cursor });
    assert.ok(data.nodes.some(n => n.id === '2'));
    assert.match(data.memoryText('1.1'), /No final memory/);
  } finally { f.runtime.dispose(); }
});
