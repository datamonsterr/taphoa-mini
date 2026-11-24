import { Text, View } from 'react-native';

import { AlternativesStrip } from '@/components/camera';
import { NextStepStrip } from '@/components/assistant/NextStepStrip';
import type { NextStepChipData } from '@/components/assistant/chip';
import type { Product } from '@/lib/api';

import { styles } from './cameraStyles';
import { MIN_SHOTS } from './quickEnroll';
import { IndexingChip } from './quickEnrollParts';
import type { Detection } from '@/components/camera/DetectionOverlay';

type Props = {
  quickActive: boolean;
  hasCurrentShot: boolean;
  acceptedCount: number;
  notice: string;
  readingReceipt: boolean;
  created: Product[];
  chips: readonly NextStepChipData[];
  onChipPress: (chip: NextStepChipData, position: number) => void;
  /** The open detection of "one" mode, whose alternatives show below the viewfinder. */
  alternatives: Detection | undefined;
  onChoose: (detectionId: string, productId: string) => void;
};

/** The fixed-height strip under the viewfinder: hints, notices, next steps or alternatives. */
export function StripSlot({
  quickActive,
  hasCurrentShot,
  acceptedCount,
  notice,
  readingReceipt,
  created,
  chips,
  onChipPress,
  alternatives,
  onChoose,
}: Props) {
  const items = alternatives?.alternatives;
  return (
    <View style={styles.stripSlot}>
      {quickActive && !hasCurrentShot && acceptedCount < MIN_SHOTS ? (
        <Text style={styles.quickHint}>Xoay sản phẩm</Text>
      ) : null}
      {notice ? (
        <Text accessibilityRole="alert" style={styles.quickHint}>
          {notice}
        </Text>
      ) : null}
      {created.map((product) => (
        <IndexingChip key={product.id} id={product.id} />
      ))}
      {!quickActive &&
      !readingReceipt &&
      !notice &&
      created.length === 0 &&
      !items ? (
        <NextStepStrip chips={chips} onPress={onChipPress} />
      ) : null}
      {alternatives && items ? (
        <AlternativesStrip
          items={items}
          currentId={items[0]!.id}
          placement="below"
          onChoose={(productId) => onChoose(alternatives.id, productId)}
        />
      ) : null}
    </View>
  );
}
