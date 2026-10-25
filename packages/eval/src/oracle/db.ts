/** What the oracle code needs from a database: a pg `Pool` or `Client` fits. */
export type Queryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{
    rows: Record<string, unknown>[];
    fields: { name: string }[];
  }>;
};
