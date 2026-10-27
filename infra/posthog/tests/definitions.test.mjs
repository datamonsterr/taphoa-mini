import { test } from 'node:test';
import assert from 'node:assert/strict';

const expected = {
  'Product overview': 8,
  'Activation funnel': 2,
  'Checkout and recognition': 5,
  'Receipts and stock': 3,
  'Assistant adoption': 8,
  'Debt book': 4,
  Reliability: 5,
};
const events = new Set([
  'signed_in',
  'signed_out',
  'account_switched',
  'store_created',
  'member_joined',
  'product_enrolled',
  'scan_completed',
  'sale_completed',
  'sale_voided',
  'receipt_scanned',
  'receipt_confirmed',
  'stock_adjusted',
  'expense_added',
  'price_changed',
  'day_closed',
  'customer_created',
  'debt_recorded',
  'debt_repaid',
  'debt_adjusted',
  'assistant_opened',
  'assistant_message_sent',
  'assistant_reply_received',
  'assistant_action_proposed',
  'assistant_action_decided',
  'assistant_feedback_given',
  'next_step_shown',
  'next_step_tapped',
  'digest_opened',
  'voice_input_used',
  '$screen',
  '$exception',
  '$rageclick',
  '$ai_trace',
]);
function checkEvents(value) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'EventsNode')
    assert.ok(events.has(value.event), value.event);
  if (value.type === 'events' && value.id)
    assert.ok(events.has(value.id), value.id);
  for (const child of Object.values(value)) checkEvents(child);
}

test('definitions cover every specified product chart with stable unique names and valid events', async () => {
  const { dashboards } = await import('../definitions/index.mjs');
  assert.deepEqual(
    Object.fromEntries(dashboards.map((d) => [d.name, d.insights.length])),
    expected,
  );
  const names = new Set();
  for (const dashboard of dashboards)
    for (const insight of dashboard.insights) {
      assert.ok(insight.name.startsWith(`${dashboard.name} · `));
      assert.ok(!names.has(insight.name));
      names.add(insight.name);
      assert.ok(insight.query.kind);
      checkEvents(insight.query);
      const source = insight.query.source;
      if (source.kind === 'HogQLQuery') {
        assert.ok(source.query.includes('{{environment}}'), insight.name);
        assert.ok(source.query.includes('{{days}}'), insight.name);
        for (const event of insight.events) assert.ok(events.has(event), event);
      }
      assert.ok(!JSON.stringify(insight.query).includes('"key":"environment"'));
    }
});

test('reliability uses logs with service, duration, route, status and resource environment', async () => {
  const { dashboards } = await import('../definitions/index.mjs');
  const logs = dashboards
    .find((d) => d.name === 'Reliability')
    .insights.slice(2);
  assert.equal(logs.length, 3);
  for (const insight of logs) {
    assert.match(insight.query.source.query, /FROM logs/);
    assert.match(
      insight.query.source.query,
      /resource_attributes\['service.name'\] = 'taphoa-backend'/,
    );
    assert.match(insight.query.source.query, /attributes\['http.route'\]/);
    assert.match(insight.query.source.query, /deployment.environment.name/);
  }
  assert.match(logs[1].query.source.query, /duration_ms/);
  assert.match(logs[2].query.source.query, /http.response.status_code/);
});

test('extra definitions include masking-compatible replay filters and the assistant kill switch', async () => {
  const { playlists, featureFlags, logViews, groupTypes, projectSettings } =
    await import('../definitions/index.mjs');
  assert.deepEqual(
    playlists.map((p) => p.name),
    ['checkout with manual lines', 'assistant error', 'rage taps'],
  );
  for (const playlist of playlists) {
    assert.equal(playlist.type, 'filters');
    checkEvents(playlist.filters);
  }
  assert.equal(
    playlists[0].filters.filter_group.values[0].values[0].properties[0].key,
    'manual_lines',
  );
  assert.deepEqual(featureFlags[0].filters.groups[0], {
    properties: [],
    rollout_percentage: 100,
  });
  assert.equal(featureFlags[0].key, 'assistant_enabled');
  assert.equal(featureFlags[0].active, true);
  assert.equal(logViews.length, 3);
  assert.equal(groupTypes[0].group_type, 'store');
  assert.equal(projectSettings.capture_console_log_opt_in, false);
});

test('overdue reminders use the emitted next-step kind and receipts attribute via at confirmation', async () => {
  const { dashboards } = await import('../definitions/index.mjs');
  const reminder = dashboards
    .find((d) => d.name === 'Debt book')
    .insights.at(-1);
  assert.equal(
    reminder.query.source.series[0].properties[0].value,
    'overdue_debts',
  );
  const receipt = dashboards.find((d) => d.name === 'Receipts and stock')
    .insights[0];
  assert.equal(
    receipt.query.source.funnelsFilter.breakdownAttributionType,
    'step',
  );
  assert.equal(receipt.query.source.funnelsFilter.breakdownAttributionValue, 1);
});
