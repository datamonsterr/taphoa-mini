import { property } from './helpers.mjs';
function playlist(name, event, properties = []) {
  return {
    name,
    description:
      'Managed by infra/posthog; replay masking is configured by the mobile SDK.',
    type: 'filters',
    filters: {
      date_from: '-30d',
      duration: [
        { type: 'recording', key: 'active_seconds', operator: 'gt', value: 5 },
      ],
      filter_group: {
        type: 'AND',
        values: [
          {
            type: 'AND',
            values: [
              { type: 'events', id: event, name: event, order: 0, properties },
            ],
          },
        ],
      },
      order: 'start_time',
    },
  };
}
export default [
  playlist('checkout with manual lines', 'sale_completed', [
    property('manual_lines', 0, 'gt'),
  ]),
  playlist('assistant error', 'assistant_reply_received', [
    property('error_code', 'is_set', 'is_set'),
  ]),
  playlist('rage taps', '$rageclick'),
];
