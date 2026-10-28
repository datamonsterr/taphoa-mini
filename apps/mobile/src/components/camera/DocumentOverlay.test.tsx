import { render, screen } from '@testing-library/react-native';

import { mapBox, type BBox } from '@/lib/bbox';
import { colors } from '@/theme';

import { DocumentHint, DocumentOverlay } from './DocumentOverlay';

const imageSize = { width: 480, height: 640 };
const viewSize = { width: 358, height: 358 };
const document = {
  detected: true,
  score: 0.9,
  text_lines: 12,
  line_boxes: [
    [0.25, 0.2, 0.5, 0.04],
    [0.25, 0.4, 0.5, 0.04],
  ],
};

test('maps every normalized line using the preview cover fit and shows the full line count', async () => {
  await render(
    <DocumentOverlay
      document={document}
      imageSize={imageSize}
      viewSize={viewSize}
    />,
  );
  document.line_boxes.forEach((line, index) => {
    const box = mapBox(
      [line[0] * 480, line[1] * 640, line[2] * 480, line[3] * 640] as BBox,
      imageSize,
      viewSize,
      'cover',
    );
    expect(screen.getByTestId(`document-line-${index}`)).toHaveStyle({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      borderWidth: 1.5,
      borderColor: colors.accent,
    });
  });
  expect(screen.getByText('Hóa đơn · 12 dòng chữ')).toHaveStyle({
    backgroundColor: colors.accent,
  });
});

test('caps boxes at 40 but retains the full count in the badge', async () => {
  await render(
    <DocumentOverlay
      document={{
        ...document,
        text_lines: 55,
        line_boxes: Array(55).fill(document.line_boxes[0]),
      }}
      imageSize={imageSize}
      viewSize={viewSize}
    />,
  );
  expect(screen.getAllByTestId(/^document-line-/)).toHaveLength(40);
  expect(screen.getByText('Hóa đơn · 55 dòng chữ')).toBeOnTheScreen();
});

test('has no document overlay for a negative signal', async () => {
  await render(
    <DocumentOverlay
      document={{ ...document, detected: false }}
      imageSize={imageSize}
      viewSize={viewSize}
    />,
  );
  expect(screen.queryByText(/Hóa đơn/)).toBeNull();
  expect(screen.queryAllByTestId(/^document-line-/)).toHaveLength(0);
});

test('shows the board hint in Vietnamese', async () => {
  await render(<DocumentHint />);
  expect(
    screen.getByText('Giữ máy thẳng, đủ sáng · chụp để đọc chữ'),
  ).toBeOnTheScreen();
});
