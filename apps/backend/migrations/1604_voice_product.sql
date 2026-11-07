ALTER TABLE voice_utterances DROP CONSTRAINT voice_utterances_mode_check;
ALTER TABLE voice_utterances ADD CONSTRAINT voice_utterances_mode_check CHECK (mode IN ('sale', 'transcribe', 'product'));
ALTER TABLE voice_utterances DROP CONSTRAINT voice_utterances_intent_check;
ALTER TABLE voice_utterances ADD CONSTRAINT voice_utterances_intent_check CHECK (intent IN ('sale', 'chat', 'none', 'product'));
