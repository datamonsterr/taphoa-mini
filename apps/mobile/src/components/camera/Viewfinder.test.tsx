import { screen, within } from '@testing-library/react-native';
import { Text } from 'react-native';

import { camera, radius } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { Viewfinder } from './Viewfinder';

describe('Viewfinder', () => {
  it('renders a square box with the large radius and children (live camera)', async () => {
    await renderWithProviders(
      <Viewfinder size={358}>
        <Text>live</Text>
      </Viewfinder>,
    );
    expect(screen.getByText('live')).toBeOnTheScreen();
    expect(screen.getByTestId('viewfinder')).toHaveStyle({
      width: 358,
      height: 358,
      borderRadius: radius.lg,
      overflow: 'hidden',
    });
    expect(screen.queryByTestId('viewfinder-photo')).toBeNull();
  });

  it('draws four corner marks', async () => {
    await renderWithProviders(<Viewfinder size={358} />);
    expect(screen.getAllByTestId('viewfinder-corner')).toHaveLength(4);
  });

  it('shows the frozen photo when given a uri, with overlay children on top', async () => {
    await renderWithProviders(
      <Viewfinder size={358} photoUri="file:///a.jpg">
        <Text>boxes</Text>
      </Viewfinder>,
    );
    expect(screen.getByTestId('viewfinder-photo')).toBeOnTheScreen();
    expect(screen.getByText('boxes')).toBeOnTheScreen();
    expect(screen.getByTestId('viewfinder')).toHaveStyle({
      backgroundColor: camera.viewfinderBg,
    });
  });
});

it('draws `behind` under the photo and children over it', async () => {
  await renderWithProviders(
    <Viewfinder size={200} photoUri="file:///p.jpg" behind={<Text>live</Text>}>
      <Text>over</Text>
    </Viewfinder>,
  );
  const frame = screen.getByTestId('viewfinder').props.children.flat(2);
  const names = frame.map(
    (c: { props?: { testID?: string; children?: string } }) =>
      c?.props?.testID ?? c?.props?.children,
  );
  const mask = screen.getByTestId('viewfinder-photo-mask');
  expect(mask).toHaveProp('collapsable', false);
  expect(within(mask).getByTestId('viewfinder-photo')).toBeOnTheScreen();
  expect(names.indexOf('live')).toBeLessThan(
    names.indexOf('viewfinder-photo-mask'),
  );
  expect(names.indexOf('viewfinder-photo-mask')).toBeLessThan(
    names.indexOf('over'),
  );
});
