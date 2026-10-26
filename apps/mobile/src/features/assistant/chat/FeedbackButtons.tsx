import { ThumbsDown, ThumbsUp } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { PressableScale } from '@/components/ui/PressableScale';
import { useT } from '@/lib/i18n';
import { colors, radius, size, space } from '@/theme';

import { useAssistantFeedback } from '../api';
import type { FeedbackRating } from '../chatReducer';
import { dict } from '../strings';

/** Thumbs up / down; pressing the selected thumb clears it locally (the server keeps the last vote). */
export const FeedbackButtons = memo(function FeedbackButtons({
  messageId,
  rating,
  onChange,
}: {
  messageId: string;
  rating: FeedbackRating | null;
  onChange: (rating: FeedbackRating | null) => void;
}) {
  const t = useT(dict);
  const feedback = useAssistantFeedback();
  const press = (next: FeedbackRating) => {
    if (rating === next) {
      onChange(null);
      return;
    }
    const previous = rating;
    onChange(next);
    feedback.mutate(
      { messageId, rating: next },
      { onError: () => onChange(previous) },
    );
  };
  const thumb = (value: FeedbackRating) => (
    <PressableScale
      testID={`feedback-${value}`}
      accessibilityRole="button"
      accessibilityLabel={t(value === 'up' ? 'thumbsUp' : 'thumbsDown')}
      accessibilityState={{ selected: rating === value }}
      onPress={() => press(value)}
      style={[styles.thumb, rating === value && styles.selected]}
    >
      <Icon
        icon={value === 'up' ? ThumbsUp : ThumbsDown}
        color={rating === value ? colors.onAccent : colors.inkMuted}
      />
    </PressableScale>
  );
  return (
    <View style={styles.row}>
      {thumb('up')}
      {thumb('down')}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[2] },
  thumb: {
    width: size.tapMin,
    height: size.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  selected: { backgroundColor: colors.accent },
});
