import type { Dict } from '@/lib/i18n';

export const voiceStrings: Dict = {
  vi: {
    hold: 'Giữ để nói',
    listening: 'Đang nghe, thả tay để dừng',
    tapToTalk: 'Chạm để nói',
    tapToStop: 'Đang nghe, chạm để dừng',
    startAction: 'Bắt đầu nói',
    stopAction: 'Dừng nói',
    unavailable: 'Máy này chưa hỗ trợ nói thành chữ',
    serverFallback:
      'Chưa gửi được lên máy chủ. Giữ nút để nói, máy sẽ tự nhận dạng.',
    transcribing: 'Đang chuyển lời nói thành chữ',
    micDenied: 'Cần cho phép micro để nói',
  },
  en: {
    hold: 'Hold to talk',
    listening: 'Listening, release to stop',
    tapToTalk: 'Tap to talk',
    tapToStop: 'Listening, tap to stop',
    startAction: 'Start talking',
    stopAction: 'Stop talking',
    unavailable: 'This device does not support speech to text',
    serverFallback:
      "Couldn't reach the server. Hold the button to talk; the phone will transcribe it.",
    transcribing: 'Turning your speech into text',
    micDenied: 'Allow the microphone to talk',
  },
};
