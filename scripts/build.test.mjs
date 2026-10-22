import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build, merge, validateSubscription } from './build.mjs';

const group = (key, name = '开屏广告', extra = {}) => ({ key, name, rules: [{ key: 1, matches: '[text="跳过"]' }], ...extra });
const subscription = (id, groups, extra = {}) => ({ id, name: `Source ${id}`, version: 10,
  categories: [], globalGroups: [], apps: [{ id: 'example.app', name: 'Example', groups }], ...extra });
const config = (count = 2) => ({ subscription: { id: 123456789, name: 'Personal' },
  sources: Array.from({ length: count }, (_, i) => ({ key: `source${i}`, name: `Source ${i}`,
    repository: `owner/source${i}`, branch: i ? 'custom' : 'main', path: 'dist/rules.json5' })) });
const appGroups = result => result.subscription.apps.find(app => app.id === 'example.app').groups;

test('validates source boundaries and rejects broken references', () => {
  assert.throws(() => validateSubscription(subscription(1, [])), /Empty subscription/);
  assert.throws(() => validateSubscription(subscription(1, [group(1), group(1)])), /duplicate/);
  assert.throws(() => validateSubscription(subscription(1, [group(1, 'A', { scopeKeys: [9] })])), /Missing scope/);
  assert.throws(() => validateSubscription(subscription(1, [group(1)], { version: -1 })), /Invalid version/);
});

test('preserves primary settings and isolates disabled supplement categories', () => {
  const primary = subscription(1, [group(7, '开屏广告-主库', { enable: true, matchTime: 9000 })], {
    categories: [{ key: 3, name: '开屏广告', enable: true }],
    globalGroups: [group(2, '开屏广告-全局', { disableIfAppGroupMatch: '开屏广告' })],
  });
  const supplement = subscription(2, [group(7, '开屏广告-补充', { matchTime: 5000, enable: true })], {
    globalGroups: [group(4, '其他全局')], categories: [{ key: 0, name: '开屏广告', enable: true }],
  });
  const original = structuredClone([primary, supplement]);
  const result = merge(config(), [primary, supplement]);
  const [main, added] = appGroups(result);
  assert.deepEqual({ ...main, key: 7 }, primary.apps[0].groups[0]);
  assert.equal(added.enable, false);
  assert.equal(added.name, '补充·Source 1｜开屏广告-补充');
  assert(!added.name.startsWith('开屏广告'));
  assert.equal(result.subscription.categories[1].name, '补充·Source 1');
  assert.equal(result.subscription.globalGroups.length, 1);
  assert.equal(result.subscription.globalGroups[0].disableIfAppGroupMatch, '开屏广告');
  assert.equal(result.report.sources[1].globalGroupsIgnored, 1);
  assert.deepEqual([primary, supplement], original);
});

test('deduplicates equivalent whole groups but keeps distinct inherited conditions', () => {
  const main = subscription(1, [group(1, 'A', { matchTime: 1000 })]);
  const extra = subscription(2, [group(8, 'Renamed', { matchTime: 1000 }),
    group(9, 'Different inherited setting', { matchTime: 2000 })]);
  const result = merge(config(), [main, extra]);
  assert.equal(appGroups(result).length, 2);
  assert.equal(result.report.sources[1].duplicatesRemoved, 1);
  const disabled = subscription(2, [group(8, 'A', { matchTime: 1000 })], {
    categories: [{ key: 1, name: 'A', enable: false }],
  });
  assert.equal(appGroups(merge(config(), [main, disabled])).length, 2);
});

test('remaps scopeKeys and preserves rule dependency and action keys', () => {
  const rules = [{ key: 10, matches: '[text="A"]', actionCdKey: 10, actionMaximumKey: 10 },
    { key: 20, matches: '[text="B"]', preKeys: [10], actionCdKey: 10, actionMaximumKey: 10 }];
  const main = subscription(1, [group(100, 'A'), group(200, 'B', { scopeKeys: [100], rules })]);
  const result = merge(config(1), [main]);
  const [first, second] = appGroups(result);
  assert.notEqual(first.key, 100);
  assert.deepEqual(second.scopeKeys, [first.key]);
  assert.deepEqual(second.rules, rules);
});

test('keeps groups referenced by scopeKeys even when equivalent groups already exist', () => {
  const main = subscription(1, [group(1, 'A')]);
  const extra = subscription(2, [group(1, 'Same content'), group(2, 'Dependent', {
    scopeKeys: [1], rules: [{ matches: '[text="Different"]' }],
  })]);
  const result = merge(config(), [main, extra]);
  const groups = appGroups(result);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[2].scopeKeys, [groups[1].key]);
  assert.equal(result.report.sources[1].duplicatesRemoved, 0);
});

test('recognizes equivalent dependency rules after upstream key renumbering', () => {
  const linked = (first, second) => [{ key: first, matches: '[text="A"]', actionCdKey: first },
    { key: second, matches: '[text="B"]', preKeys: first, actionMaximumKey: first }];
  const result = merge(config(), [subscription(1, [group(1, 'A', { rules: linked(10, 20) })]),
    subscription(2, [group(9, 'B', { rules: linked(50, 60) })])]);
  assert.equal(appGroups(result).length, 1);
  assert.equal(result.report.sources[1].duplicatesRemoved, 1);
});

test('keeps stable group identifiers across deletion, addition, source reorder and restoration', () => {
  const sources = config();
  const a = subscription(1, [group(10, 'A'), group(20, 'B', { matchTime: 2000 })]);
  const b = subscription(2, [group(10, 'C', { matchTime: 3000 })]);
  const first = merge(sources, [a, b]);
  const keys = result => Object.fromEntries(result.report.groups.map(g => [`${g.source}/${g.upstreamKey}`, g.key]));
  const original = keys(first);
  const removed = merge(sources, [subscription(1, [a.apps[0].groups[1]]), b], first.state);
  const added = merge(sources, [subscription(1, [group(30, 'New', { matchTime: 4000 }), ...a.apps[0].groups]), b], removed.state);
  for (const [id, key] of Object.entries(original)) assert.equal(keys(added)[id], key);
  assert(!Object.values(original).includes(keys(added)['source0/30']));
  const reversed = merge({ ...sources, sources: [...sources.sources].reverse() }, [b, a], added.state);
  for (const [id, key] of Object.entries(original)) assert.equal(keys(reversed)[id], key);
});

async function fixture(t, inputs = [subscription(1, [group(1)])]) {
  const root = await mkdtemp(join(tmpdir(), 'gkd-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = config(inputs.length);
  await writeFile(join(root, 'sources.json'), JSON.stringify(settings));
  const fetcher = async url => {
    const index = settings.sources.findIndex(source => url.includes(`/${source.repository}/`));
    assert(index >= 0, `Unexpected request: ${url}`);
    assert(url.includes(`/${settings.sources[index].branch}/`));
    return new Response(JSON.stringify(inputs[index]), { status: 200 });
  };
  return { root, inputs, fetcher };
}

const published = async root => Object.fromEntries(await Promise.all([
  'dist/gkd.json5', 'dist/gkd.version.json5', 'dist/report.json', 'state.json',
].map(async path => [path, await readFile(join(root, path), 'utf8')])));

test('first build publishes and content alone controls version increments', async t => {
  const f = await fixture(t);
  const first = await build(f.root, f.fetcher);
  assert.equal(first.changed, true);
  assert.equal(first.version, 1);
  const second = await build(f.root, f.fetcher);
  assert.equal(second.changed, false);
  assert.equal(second.version, 1);
  f.inputs[0].version++;
  const upstreamOnly = await build(f.root, f.fetcher);
  assert.equal(upstreamOnly.changed, false);
  assert.equal(upstreamOnly.version, 1);
  f.inputs[0].apps[0].groups[0].rules[0].matches = '[text="Updated"]';
  const changed = await build(f.root, f.fetcher);
  assert.equal(changed.changed, true);
  assert.equal(changed.version, 2);
  const saved = await published(f.root);
  const data = JSON.parse(saved['dist/gkd.json5']);
  assert.equal(data.id, 123456789);
  assert.equal(data.version, 2);
  assert.equal(data.checkUpdateUrl, './gkd.version.json5');
  assert.deepEqual(JSON.parse(saved['dist/gkd.version.json5']), { id: data.id, version: 2 });
});

for (const [name, failure, expected] of [
  ['HTTP fetch failure', () => new Response('Unavailable', { status: 503 }), /HTTP 503/],
  ['network rejection', () => { throw Error('Network offline'); }, /Network offline/],
  ['empty subscription', data => { data.apps = []; return data; }, /Empty subscription/],
  ['source identifier change', data => { data.id = 999; return data; }, /source id changed/],
  ['source version regression', data => { data.version--; return data; }, /version regressed/],
  ['large app truncation', data => { data.apps = data.apps.slice(0, 1); return data; }, /app count fell/],
  ['large group truncation', data => { for (const app of data.apps) app.groups = app.groups.slice(0, 1); return data; }, /group count fell/],
]) {
  test(`${name} leaves every previously published file intact`, async t => {
    const source = subscription(1, [], { apps: Array.from({ length: 4 }, (_, i) => ({
      id: `example.app${i}`, groups: Array.from({ length: 4 }, (_, j) => group(j, `Group ${j}`)),
    })) });
    const f = await fixture(t, [source]);
    await build(f.root, f.fetcher);
    const before = await published(f.root);
    const badFetcher = async () => {
      const result = failure(structuredClone(source));
      return result instanceof Response ? result : new Response(JSON.stringify(result));
    };
    await assert.rejects(build(f.root, badFetcher), expected);
    assert.deepEqual(await published(f.root), before);
  });
}
