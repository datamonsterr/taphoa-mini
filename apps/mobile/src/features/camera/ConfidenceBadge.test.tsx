import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { ConfidenceBadge } from './ConfidenceBadge';

describe('ConfidenceBadge', () => {
  it('sits above the box when there is room (board 02)', async () => {
    await renderWithProviders(
      <ConfidenceBadge
        box={{ x: 100, y: 120, width: 160, height: 160 }}
        percent={96}
        low={false}
      />,
    );
    expect(screen.getByTestId('confidence-badge')).toHaveStyle({
      left: 100,
      top: 90,
      backgroundColor: colors.successSoft,
    });
  });

  // #182: a box at the frame's top edge put the badge over the corner mark.
  it('moves right of the corner mark when the box hugs the top-left', async () => {
    await renderWithProviders(
      <ConfidenceBadge
        box={{ x: 0, y: 0, width: 360, height: 360 }}
        percent={74}
        low
      />,
    );
    expect(screen.getByTestId('confidence-badge')).toHaveStyle({
      left: 44,
      top: 6,
      backgroundColor: colors.warningSoft,
    });
  });

  it('shows no score when the server had no candidate', async () => {
    await renderWithProviders(
      <ConfidenceBadge
        box={{ x: 100, y: 120, width: 160, height: 160 }}
        percent={null}
        low
      />,
    );
    expect(screen.getByLabelText('Chưa nhận ra món này')).toBeOnTheScreen();
    expect(screen.queryByText('0')).toBeNull();
  });
});
