export default [
  {
    name: 'errors',
    filters: {
      severityLevels: ['error', 'fatal'],
      serviceNames: ['taphoa-backend'],
    },
  },
  {
    name: 'assistant',
    filters: { searchTerm: 'assistant', serviceNames: ['taphoa-backend'] },
  },
  {
    name: 'recognition',
    filters: {
      searchTerm: 'recognition.scan',
      serviceNames: ['taphoa-backend'],
    },
  },
];
