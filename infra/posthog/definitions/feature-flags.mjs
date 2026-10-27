export default [
  {
    key: 'assistant_enabled',
    name: 'Assistant enabled (kill switch)',
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100 }],
      multivariate: null,
      payloads: {},
    },
  },
];
