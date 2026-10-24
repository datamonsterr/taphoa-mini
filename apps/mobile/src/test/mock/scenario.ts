export type MockScenario = 'auto' | 'match' | 'multi' | 'unknown' | 'ambiguous';

let scenario: MockScenario = 'auto';

/** Forces what `createScan` returns. `auto` follows the scan mode; every 3rd single scan is unknown. */
export function setMockScenario(next: MockScenario): void {
  scenario = next;
}

export function getMockScenario(): MockScenario {
  return scenario;
}

export function resetMockScenario(): void {
  scenario = 'auto';
}
