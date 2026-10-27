import { describe, expect, it } from 'vitest';
import { scoreToolSelection } from './tools.ts';

describe('scoreToolSelection', () => {
  it('scores 1 when every must tool was called', () => {
    const expectTools = {
      must: ['get_restock_plan', 'get_stock_levels'],
      must_not: [],
    };
    expect(
      scoreToolSelection(['get_stock_levels', 'get_restock_plan'], expectTools),
    ).toBe(1);
    expect(scoreToolSelection(['get_restock_plan'], expectTools)).toBe(0);
    expect(scoreToolSelection([], expectTools)).toBe(0);
  });

  it('allows extra tools that are not forbidden', () => {
    expect(
      scoreToolSelection(['search_help', 'get_restock_plan'], {
        must: ['get_restock_plan'],
        must_not: [],
      }),
    ).toBe(1);
  });

  it('scores 0 when a must_not tool was called', () => {
    const expectTools = {
      must: ['get_restock_plan'],
      must_not: ['propose_stock_adjustment'],
    };
    expect(
      scoreToolSelection(
        ['get_restock_plan', 'propose_stock_adjustment'],
        expectTools,
      ),
    ).toBe(0);
    expect(scoreToolSelection(['get_restock_plan'], expectTools)).toBe(1);
  });

  it('needs one tool from each any_of group', () => {
    const expectTools = {
      must: [],
      must_not: [],
      any_of: [
        ['get_sales_summary', 'get_top_products'],
        ['search_help', 'get_store_overview'],
      ],
    };
    expect(
      scoreToolSelection(['get_top_products', 'search_help'], expectTools),
    ).toBe(1);
    expect(
      scoreToolSelection(
        ['get_sales_summary', 'get_top_products', 'get_store_overview'],
        expectTools,
      ),
    ).toBe(1);
    expect(scoreToolSelection(['get_top_products'], expectTools)).toBe(0);
    expect(scoreToolSelection([], expectTools)).toBe(0);
  });

  it('treats an empty any_of group as satisfied', () => {
    expect(
      scoreToolSelection([], { must: [], must_not: [], any_of: [[]] }),
    ).toBe(1);
  });

  it('scores an off-topic case with no tools as 1', () => {
    const expectTools = { must: [], must_not: ['get_store_overview'] };
    expect(scoreToolSelection([], expectTools)).toBe(1);
    expect(scoreToolSelection(['get_store_overview'], expectTools)).toBe(0);
  });

  it('counts a repeated call once', () => {
    expect(
      scoreToolSelection(['get_dead_stock', 'get_dead_stock'], {
        must: ['get_dead_stock'],
        must_not: [],
      }),
    ).toBe(1);
  });
});
