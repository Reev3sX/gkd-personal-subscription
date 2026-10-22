import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';

const INT_MAX = 2147483647;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const integer = value => Number.isInteger(value) && value >= -2147483648 && value <= INT_MAX;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label}: duplicate identifiers`);
}

export function validateSubscription(data) {
  assert(object(data), 'Subscription must be an object');
  assert(Number.isSafeInteger(data.id) && data.id > 0, 'Invalid subscription id');
  assert(integer(data.version) && data.version >= 0, 'Invalid version');
  assert(typeof data.name === 'string' && data.name.length, 'Missing subscription name');
  for (const key of ['apps', 'categories', 'globalGroups']) {
    assert(data[key] === undefined || Array.isArray(data[key]), `Invalid ${key}`);
  }
  const apps = data.apps ?? [];
  unique(apps.map(app => app.id), 'apps');
  for (const app of apps) {
    assert(typeof app.id === 'string' && app.id.length, 'Invalid app id');
    assert(Array.isArray(app.groups), `Invalid groups: ${app.id}`);
  }
  const categories = data.categories ?? [];
  unique(categories.map(c => c.key), 'categories');
  for (const category of categories) {
    assert(integer(category.key) && typeof category.name === 'string' && category.name.length, 'Invalid category');
    assert(category.enable == null || typeof category.enable === 'boolean', 'Invalid category enable');
  }
  for (const [id, groups] of [...apps.map(app => [app.id, app.groups]), ['global', data.globalGroups ?? []]]) {
    unique(groups.map(group => group.key), `groups: ${id}`);
    for (const group of groups) {
      assert(integer(group.key) && typeof group.name === 'string' && group.name.length, `Invalid group: ${id}`);
      assert(group.enable == null || typeof group.enable === 'boolean', `Invalid enable: ${id}`);
      const rules = array(group.rules);
      assert(rules.length > 0, `Empty rules: ${id}/${group.key}`);
      for (const rule of rules) {
        assert(typeof rule === 'string' || object(rule), `Invalid rule: ${id}/${group.key}`);
        if (object(rule) && rule.key != null) assert(integer(rule.key), 'Invalid rule key');
      }
      unique(rules.filter(r => object(r) && r.key != null).map(r => r.key), `rules: ${id}/${group.key}`);
      for (const key of array(group.scopeKeys)) {
        assert(integer(key) && groups.some(g => g.key === key), `Missing scope group: ${id}/${group.key}/${key}`);
      }
    }
  }
  assert(apps.some(app => app.groups.length) || data.globalGroups?.length, 'Empty subscription');
  return data;
}

// Compare whole groups with their inherited settings; never normalize selector text.
function fingerprint(group, categories) {
  const copy = structuredClone(group);
  copy.enable = categories.find(c => group.name.startsWith(c.name))?.enable ?? group.enable ?? true;
  const rules = array(copy.rules).map(r => typeof r === 'string' ? { matches: r } : r);
  const keys = new Map(rules.flatMap((r, index) => r.key == null ? [] : [[r.key, index]]));
  const metadata = ['key', 'name', 'desc', 'snapshotUrls', 'exampleUrls'];
  function clean(item) {
    for (const key of ['preKeys', 'actionCdKey', 'actionMaximumKey']) {
      if (item[key] != null) item[key] = array(item[key]).map(k => keys.has(k) ? `rule:${keys.get(k)}` : `external:${k}`);
    }
    for (const key of metadata) delete item[key];
    return item;
  }
  copy.rules = rules.map(clean);
  return digest(clean(copy));
}

export function merge(config, inputs, previousState = { next: 1, keys: {} }) {
  assert(config.sources.length && config.sources.length === inputs.length, 'Every source is required');
  unique(config.sources.map(s => s.key), 'sources');
  assert(object(previousState.keys) && integer(previousState.next) && previousState.next > 0, 'Invalid key state');
  const usedKeys = Object.values(previousState.keys);
  unique(usedKeys, 'saved keys');
  assert(usedKeys.every(k => integer(k) && k > 0 && k < previousState.next), 'Invalid saved key');
  const state = structuredClone(previousState);
  function keyFor(parts) {
    const id = JSON.stringify(parts);
    if (state.keys[id] === undefined) {
      assert(state.next < INT_MAX, 'Key space exhausted');
      state.keys[id] = state.next++;
    }
    return state.keys[id];
  }
  const apps = new Map();
  const fingerprints = new Map();
  const categories = [];
  const globalGroups = [];
  const counts = [];
  const kept = [];
  for (const [index, source] of config.sources.entries()) {
    const data = validateSubscription(inputs[index]);
    if (source.subscriptionId !== undefined) assert.equal(data.id, source.subscriptionId, `Source id changed: ${source.key}`);
    const primary = index === 0;
    const sourceApps = data.apps ?? [];
    const stat = { key: source.key, repository: source.repository, branch: source.branch, path: source.path,
      version: data.version, id: data.id, apps: sourceApps.length,
      groups: sourceApps.reduce((sum, app) => sum + app.groups.length, 0),
      kept: 0, duplicatesRemoved: 0, globalGroupsIgnored: primary ? 0 : (data.globalGroups ?? []).length };
    counts.push(stat);
    if (primary) {
      categories.push(...(data.categories ?? []).map(category => ({ ...category, key: keyFor(['category', source.key, category.key]) })));
    } else {
      // A separate prefix keeps supplement switches independent of the primary categories/global exclusions.
      categories.push({ key: keyFor(['category', source.key]), name: `补充·${source.name}` });
    }
    const lists = (data.apps ?? []).map(app => ({ app, groups: app.groups }));
    if (primary) lists.push({ app: null, groups: data.globalGroups ?? [] });
    for (const { app, groups } of lists) {
      const scope = app?.id ?? '$global';
      const protectedKeys = new Set(groups.flatMap(group => group.scopeKeys == null ? [] : [group.key, ...array(group.scopeKeys)]));
      const mapped = new Map(groups.map(group => [group.key, keyFor(['group', source.key, scope, group.key])]));
      for (const original of groups) {
        const fp = !protectedKeys.has(original.key) ? fingerprint(original, data.categories ?? []) : null;
        const seen = fingerprints.get(scope) ?? new Set();
        fingerprints.set(scope, seen);
        if (!primary && fp && seen.has(fp)) { stat.duplicatesRemoved++; continue; }
        if (fp) seen.add(fp);
        const group = { ...structuredClone(original), key: mapped.get(original.key) };
        if (original.scopeKeys != null) group.scopeKeys = array(original.scopeKeys).map(k => mapped.get(k));
        if (!primary) {
          group.name = `补充·${source.name}｜${original.name}`;
          group.enable = true;
        }
        if (app) {
          if (!apps.has(app.id)) apps.set(app.id, { ...structuredClone(app), groups: [] });
          apps.get(app.id).groups.push(group);
        } else globalGroups.push(group);
        kept.push({ source: source.key, app: scope, upstreamKey: original.key, key: group.key });
        stat.kept++;
      }
    }
  }
  const subscription = { ...config.subscription, version: 0, checkUpdateUrl: './gkd.version.json5',
    categories, globalGroups, apps: [...apps.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')) };
  assert(!subscription.updateUrl, 'Omit updateUrl to keep the user supplied endpoint');
  validateSubscription(subscription);
  return { subscription, state, report: { sources: counts, groups: kept } };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function build(root = '.', fetcher = fetch) {
  const config = await readJson(resolve(root, 'sources.json'));
  const old = await readJson(resolve(root, 'dist/gkd.json5'), null);
  const last = await readJson(resolve(root, 'dist/report.json'), null);
  const state = await readJson(resolve(root, 'state.json'), { next: 1, keys: {} });
  if (old) {
    validateSubscription(old);
    assert.equal(old.id, config.subscription.id, 'Subscription id must stay stable');
    assert(last && Object.keys(state.keys).length, 'Published subscription requires its report and key state');
  }
  const inputs = await Promise.all(config.sources.map(async source => {
    assert(/^[\w.-]+\/[\w.-]+$/.test(source.repository), 'Invalid repository');
    const url = `https://raw.githubusercontent.com/${source.repository}/${encodeURIComponent(source.branch)}/${source.path}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'gkd-personal-subscription' } });
    assert(response.ok, `${source.key}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length <= 10 * 1024 * 1024, `${source.key}: source too large`);
    const data = validateSubscription(JSON5.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const prior = last?.sources.find(s => s.key === source.key);
    if (prior) {
      assert.equal(data.id, prior.id, `${source.key}: source id changed`);
      assert(data.version >= prior.version, `${source.key}: source version regressed`);
      assert(data.apps.length >= prior.apps / 2, `${source.key}: app count fell by more than half`);
      assert(data.apps.reduce((n, a) => n + a.groups.length, 0) >= prior.groups / 2, `${source.key}: group count fell by more than half`);
    }
    return data;
  }));
  const result = merge(config, inputs, state);
  const hash = digest({ ...result.subscription, version: 0 });
  const unchanged = old && digest({ ...old, version: 0 }) === hash;
  result.subscription.version = unchanged ? old.version : (old?.version ?? 0) + 1;
  assert(integer(result.subscription.version), 'Version space exhausted');
  const report = { version: result.subscription.version, contentHash: hash, ...result.report,
    apps: result.subscription.apps.length,
    appGroups: result.subscription.apps.reduce((n, a) => n + a.groups.length, 0),
    globalGroups: result.subscription.globalGroups.length };
  const files = {
    'dist/gkd.json5': result.subscription,
    'dist/gkd.version.json5': { id: result.subscription.id, version: result.subscription.version },
    'dist/report.json': report,
    'state.json': result.state,
  };
  // Network/parse/merge checks all finish before any published file is replaced.
  for (const [path, value] of Object.entries(files)) {
    const filename = resolve(root, path);
    await mkdir(resolve(filename, '..'), { recursive: true });
    await writeFile(`${filename}.tmp`, JSON.stringify(value, null, 2) + '\n');
    await rename(`${filename}.tmp`, filename);
  }
  return { changed: !unchanged, version: report.version, apps: report.apps, appGroups: report.appGroups,
    globalGroups: report.globalGroups, sources: report.sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  build().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`Build stopped; no update will be published: ${error.message}`);
    process.exitCode = 1;
  });
}
