import type { AssistantAction } from '@taphoa/api-client';
import { Check, X } from 'lucide-react-native';
import { memo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Text } from '@/components/ui/ScaledText';
import { useT } from '@/lib/i18n';
import { colors, space, typography } from '@/theme';

import type {
  AssistantChatMessage,
  FeedbackRating,
  ToolLine,
} from '../chatReducer';
import { plainMoney } from '../money';
import { dict } from '../strings';
import { ActionCard } from './ActionCard';
import { CardView } from './cards/CardView';
import type { ReceiptCardLine } from './cards/ReceiptLinesCard';
import { ErrorNotice } from './ErrorNotice';
import { FeedbackButtons } from './FeedbackButtons';

const ToolStatus = memo(function ToolStatus({ tool }: { tool: ToolLine }) {
  const t = useT(dict);
  return (
    <View
      testID={`tool-line-${tool.call_id}-${tool.status}`}
      style={styles.tool}
    >
      {tool.status === 'running' ? (
        <ActivityIndicator
          size="small"
          color={colors.inkMuted}
          accessibilityLabel={t('toolRunning')}
        />
      ) : (
        <Icon
          icon={tool.status === 'ok' ? Check : X}
          size={18}
          color={tool.status === 'ok' ? colors.inkMuted : colors.danger}
        />
      )}
      <Text style={styles.toolText}>
        {tool.status === 'running'
          ? tool.label
          : tool.status === 'ok'
            ? plainMoney(tool.summary ?? tool.label)
            : plainMoney(tool.summary ?? t('toolFailed'))}
      </Text>
    </View>
  );
});

export type AssistantMessageViewProps = {
  message: AssistantChatMessage;
  onRetry: () => void;
  onLinePress: (line: ReceiptCardLine) => void;
  onActionUpdate: (action: AssistantAction) => void;
  onFeedback: (messageId: string, rating: FeedbackRating | null) => void;
};

/** One assistant turn: tool status lines, streamed text, cards, proposals, error, feedback. */
export const AssistantMessageView = memo(function AssistantMessageView({
  message,
  onRetry,
  onLinePress,
  onActionUpdate,
  onFeedback,
}: AssistantMessageViewProps) {
  const t = useT(dict);
  return (
    <View style={styles.message} testID="assistant-message">
      {message.tools.map((tool) => (
        <ToolStatus key={tool.call_id} tool={tool} />
      ))}
      {message.text ? (
        <Text style={styles.text}>{plainMoney(message.text)}</Text>
      ) : null}
      {message.status === 'streaming' && !message.text ? (
        <View testID="assistant-typing" style={styles.typing}>
          <ActivityIndicator
            size="small"
            color={colors.inkMuted}
            accessibilityLabel={t('typing')}
          />
        </View>
      ) : null}
      {message.cards.map((card, index) => (
        <CardView
          key={`${card.type}-${index}`}
          card={card}
          onLinePress={onLinePress}
        />
      ))}
      {message.actions.map((action) => (
        <ActionCard key={action.id} action={action} onUpdate={onActionUpdate} />
      ))}
      {message.status === 'error' && message.error ? (
        <ErrorNotice
          error={message.error}
          {...(message.retried ? {} : { onRetry })}
        />
      ) : null}
      {message.status === 'done' && message.remote ? (
        <FeedbackButtons
          messageId={message.id}
          rating={message.feedback}
          onChange={(rating) => onFeedback(message.id, rating)}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  message: { gap: space[3], alignItems: 'stretch' },
  text: { ...typography.body, color: colors.ink },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    alignSelf: 'flex-start',
  },
  toolText: { ...typography.caption, color: colors.inkMuted },
  typing: { alignSelf: 'flex-start', padding: space[2] },
});
