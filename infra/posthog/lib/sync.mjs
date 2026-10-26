// Compare only fields owned by definitions; PostHog may add nested defaults.
function matches(existing, desired) {
  if (Array.isArray(desired))
    return (
      Array.isArray(existing) &&
      existing.length === desired.length &&
      desired.every((item, index) => matches(existing[index], item))
    );
  if (desired && typeof desired === 'object')
    return (
      existing != null &&
      Object.entries(desired).every(([key, value]) =>
        matches(existing[key], value),
      )
    );
  return Object.is(existing, desired);
}
async function upsert(
  context,
  definition,
  { endpoint, key = 'name', idKey = 'id', search = '' },
) {
  const { client, dryRun = false } = context;
  const found = (await client.listAll(endpoint + search)).filter(
    (item) => item[key] === definition[key],
  );
  if (found.length > 1)
    throw new Error(`Ambiguous ${endpoint} match for ${definition[key]}`);
  const existing = found[0];
  if (existing && matches(existing, definition))
    return { action: 'noop', status: 'unchanged', object: existing };
  const action = existing ? 'update' : 'create';
  const object = dryRun
    ? {
        ...existing,
        ...definition,
        [idKey]: existing?.[idKey] ?? `planned:${definition[key]}`,
      }
    : existing
      ? await client.patch(
          `${endpoint}${encodeURIComponent(existing[idKey])}/`,
          definition,
        )
      : await client.post(endpoint, definition);
  return { action, object, payload: definition };
}
export const ensureDashboard = (ctx, def) =>
  upsert(ctx, def, { endpoint: 'dashboards/' });
export const ensureInsight = (ctx, def) =>
  upsert(ctx, def, {
    endpoint: 'insights/',
    search: `?basic=true&limit=100&search=${encodeURIComponent(def.name)}`,
  });
export const ensureFeatureFlag = (ctx, def) =>
  upsert(ctx, def, { endpoint: 'feature_flags/', key: 'key' });
export const ensurePlaylist = (ctx, def) =>
  upsert(ctx, def, {
    endpoint: 'session_recording_playlists/',
    idKey: 'short_id',
  });
export const ensureLogView = (ctx, def) =>
  upsert(ctx, def, { endpoint: 'logs/views/', idKey: 'short_id' });
export async function ensureGroupTypeMetadata(
  { client, dryRun = false },
  definition,
) {
  const existing = (await client.listAll('groups_types/')).find(
    (item) => item.group_type === definition.group_type,
  );
  if (!existing)
    return {
      action: 'skip',
      warning: `Group type ${definition.group_type} does not exist; send $groupidentify first`,
    };
  const { name_singular, name_plural } = definition;
  if (matches(existing, { name_singular, name_plural }))
    return { action: 'noop', status: 'unchanged', object: existing };
  const payload = [
    { group_type_index: existing.group_type_index, name_singular, name_plural },
  ];
  if (!dryRun) await client.patch('groups_types/update_metadata/', payload);
  return { action: 'update', payload };
}
export async function ensureProjectSettings(
  { client, projectId, dryRun = false },
  definition,
) {
  const project = await client.get('');
  if (matches(project, definition))
    return { action: 'noop', status: 'unchanged', object: project };
  if (!dryRun)
    await client.patch(
      `/api/organizations/${encodeURIComponent(project.organization)}/projects/${encodeURIComponent(projectId)}/`,
      definition,
    );
  return { action: 'update', payload: definition };
}
