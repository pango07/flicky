// ── Voice / State Machine ──────────────────────────────────────────────

export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

export type BuddyNavigationMode =
  | 'followingCursor'
  | 'navigatingToTarget'
  | 'pointingAtTarget';

// ── Transcription ──────────────────────────────────────────────────────

export type TranscriptionProviderType = 'groq' | 'openai' | 'native';

export type GroqTranscriptionModel =
  | 'whisper-large-v3'
  | 'whisper-large-v3-turbo';

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
}

// ── Screen Capture ─────────────────────────────────────────────────────

export interface ScreenCapture {
  dataBase64: string;
  displayId: number;
  imageWidth: number;
  imageHeight: number;
  displayBounds: { x: number; y: number; width: number; height: number };
  isCursorScreen: boolean;
}

// ── Claude API ─────────────────────────────────────────────────────────

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-opus-4-6';

export type OpenAIModel = 'gpt-5' | 'gpt-5-mini' | 'gpt-4o';

/** Which service backs the Mind (reasoning) capability. */
export type MindProvider = 'anthropic' | 'openai' | 'ollama';

/** Extended-thinking budget mapping. */
export type ReasoningDepth = 'off' | 'medium' | 'deep';

/** System-prompt variant. */
export type ReplyTone = 'concise' | 'friendly' | 'detailed';

/** How the push-to-talk shortcut behaves. */
export type PttMode = 'hold' | 'toggle';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── Element Pointing ───────────────────────────────────────────────────

export interface DetectedElement {
  x: number;
  y: number;
  label: string;
  screenIndex: number;
}

export interface WalkthroughStep extends DetectedElement {
  /** 1-based position in the walkthrough sequence. */
  step: number;
  /** Total number of steps in the walkthrough. */
  total: number;
}

export interface Walkthrough {
  steps: WalkthroughStep[];
}

/**
 * A request from the model to type text into whatever field the user
 * has focused. Currently fulfilled via clipboard handoff (text copied
 * to clipboard, user presses ⌘V); a future "auto-type" mode will use
 * a native key-event hook to type directly when the user has opted in.
 */
export interface TypeRequest {
  text: string;
  /** What was typed/copied — surfaced in the toast UI for confirmation. */
  preview: string;
  /** True when the text was actually auto-typed; false when copied. */
  autoTyped: boolean;
}

// ── Local Connections (Ollama / OpenAI-compatible local endpoints) ─────

export interface OllamaModelInfo {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
  digest?: string;
}

export interface LocalConnection {
  id: string;
  type: 'local' | 'external';
  label?: string;
  url: string;
  enabled: boolean;
  bearerEnabled: boolean;
  prefixId?: string;
  modelIds: string[];
  activeModelId?: string;
  tags: string[];
}

// ── API Keys ───────────────────────────────────────────────────────────

export type ApiKeyName = 'anthropic' | 'openai' | 'elevenlabs' | 'groq';

export interface ApiKeyStatus {
  anthropic: boolean;
  openai: boolean;
  elevenlabs: boolean;
  groq: boolean;
}

// ── Voice / TTS ────────────────────────────────────────────────────────

/** Built-in voice presets we curate for the voice picker. */
export interface VoicePreset {
  id: string;
  name: string;
  description: string;
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'Fahco4VZzobUeiPqni1S', name: 'Tom', description: 'custom · en-US' },
  { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', description: 'warm · conversational · en-US' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'calm · narrator · en-US' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', description: 'strong · confident · en-US' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', description: 'soft · friendly · en-US' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'well-rounded · en-US' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', description: 'crisp · narration · en-US' },
];

// ── Chat History ───────────────────────────────────────────────────────

export interface ChatEntry {
  id: string;
  timestamp: number;
  userText: string;
  assistantText: string;
}

// ── Memory / Context ───────────────────────────────────────────────────

export interface MemoryStats {
  /** Approximate total tokens currently held in context. */
  tokens: number;
  /** Soft cap that triggers auto-compaction. */
  tokenBudget: number;
  /** Full messages held verbatim. */
  messageCount: number;
  /** Messages that have been summarized into the rolling summary. */
  summarizedCount: number;
  /** Whether a rolling summary is currently prepended to context. */
  hasSummary: boolean;
  /** Unix ms of last auto/manual compaction, or null. */
  lastCompactedAt: number | null;
}

// ── Settings ───────────────────────────────────────────────────────────

export type StreamVisibility = 'off' | 'responses' | 'always';

export interface StreamWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlickySettings {
  // Mind
  mindProvider: MindProvider;
  selectedModel: ClaudeModel;
  selectedOpenAIModel: OpenAIModel;
  reasoningDepth: ReasoningDepth;
  replyTone: ReplyTone;

  // Voice (TTS)
  voiceId: string;
  voiceSpeed: number;    // 0.7 – 1.2 (ElevenLabs accepted range)
  voiceStability: number; // 0 – 1
  speakReplies: boolean;

  // Ear (transcription)
  groqTranscriptionModel: GroqTranscriptionModel;
  transcriptionProvider: TranscriptionProviderType;

  // General
  isClickyCursorEnabled: boolean;
  launchAtLogin: boolean;
  pushToTalkShortcut: string;
  /**
   * How the push-to-talk shortcut behaves:
   *   'hold'   — record while the key is held, send on release
   *               (Windows/Linux only; macOS falls back to 'toggle' because
   *               Electron's globalShortcut exposes no key-up event there)
   *   'toggle' — first tap starts recording, second tap stops and sends
   */
  pttMode: PttMode;
  /**
   * If true, Flicky may type text directly into the focused field when
   * the model emits a [TYPE:...] tag. Requires Accessibility permission
   * on macOS and the native auto-typer module to be available; falls
   * back to clipboard handoff in either case. Off by default.
   */
  autoTypeEnabled: boolean;
  /**
   * Controls the transparent stream window:
   * - 'off'       — never shown
   * - 'responses' — shown only while Flicky is actively answering
   * - 'always'    — shown continuously once the app starts
   */
  streamVisibility: StreamVisibility;
  /** Last known position + size of the stream window; null = auto-place. */
  streamWindowBounds: StreamWindowBounds | null;

  // Local model connections
  localConnections: LocalConnection[];

  // Lifecycle
  onboardingComplete: boolean;
  apiKeyStatus: ApiKeyStatus;
}

export const DEFAULT_SETTINGS: FlickySettings = {
  mindProvider: 'anthropic',
  selectedModel: 'claude-sonnet-4-6',
  selectedOpenAIModel: 'gpt-5',
  reasoningDepth: 'off',
  replyTone: 'friendly',

  voiceId: 'pMsXgVXv3BLzUgSXRplE',
  voiceSpeed: 1.0,
  voiceStability: 0.5,
  speakReplies: true,

  groqTranscriptionModel: 'whisper-large-v3-turbo',
  transcriptionProvider: 'groq',

  isClickyCursorEnabled: true,
  launchAtLogin: false,
  pushToTalkShortcut: 'Ctrl+Alt+X',
  pttMode: 'hold',
  autoTypeEnabled: false,
  streamVisibility: 'off',
  streamWindowBounds: null,

  localConnections: [],

  onboardingComplete: false,
  apiKeyStatus: { anthropic: false, openai: false, elevenlabs: false, groq: false },
};

// ── IPC Channels ───────────────────────────────────────────────────────

export const IPC = {
  // Main → Renderer
  VOICE_STATE_CHANGED: 'voice-state-changed',
  TRANSCRIPT_UPDATE: 'transcript-update',
  AI_RESPONSE_CHUNK: 'ai-response-chunk',
  AI_RESPONSE_COMPLETE: 'ai-response-complete',
  ELEMENT_DETECTED: 'element-detected',
  WALKTHROUGH: 'walkthrough',
  WALKTHROUGH_STEP: 'walkthrough-step',
  TYPE_FULFILLED: 'type-fulfilled',
  CURSOR_POSITION: 'cursor-position',
  SETTINGS_CHANGED: 'settings-changed',
  PERMISSION_STATUS: 'permission-status',
  MEMORY_STATS: 'memory-stats',
  CHAT_ENTRY_ADDED: 'chat-entry-added',

  // Renderer → Main
  PUSH_TO_TALK_START: 'push-to-talk-start',
  PUSH_TO_TALK_STOP: 'push-to-talk-stop',
  SET_MODEL: 'set-model',
  SET_OPENAI_MODEL: 'set-openai-model',
  SET_MIND_PROVIDER: 'set-mind-provider',
  SET_REASONING_DEPTH: 'set-reasoning-depth',
  SET_REPLY_TONE: 'set-reply-tone',
  SET_VOICE_ID: 'set-voice-id',
  SET_VOICE_SPEED: 'set-voice-speed',
  SET_VOICE_STABILITY: 'set-voice-stability',
  SET_SPEAK_REPLIES: 'set-speak-replies',
  SET_GROQ_MODEL: 'set-groq-model',
  TOGGLE_CURSOR: 'toggle-cursor',
  SET_LAUNCH_AT_LOGIN: 'set-launch-at-login',
  SET_PUSH_TO_TALK_SHORTCUT: 'set-push-to-talk-shortcut',
  SET_PTT_MODE: 'set-ptt-mode',
  SET_AUTO_TYPE_ENABLED: 'set-auto-type-enabled',
  SET_STREAM_VISIBILITY: 'set-stream-visibility',
  SET_STREAM_WINDOW_BOUNDS: 'set-stream-window-bounds',
  CLEAR_STREAM: 'clear-stream',
  SUSPEND_PUSH_TO_TALK_SHORTCUT: 'suspend-push-to-talk-shortcut',
  RESUME_PUSH_TO_TALK_SHORTCUT: 'resume-push-to-talk-shortcut',
  GET_SETTINGS: 'get-settings',
  GET_PERMISSIONS: 'get-permissions',
  REQUEST_PERMISSION: 'request-permission',
  OPEN_EXTERNAL: 'open-external',
  QUIT_APP: 'quit-app',
  REPLAY_ONBOARDING: 'replay-onboarding',
  COMPLETE_ONBOARDING: 'complete-onboarding',
  CLEAR_CONTEXT: 'clear-context',
  COMPACT_CONTEXT: 'compact-context',
  GET_MEMORY_STATS: 'get-memory-stats',
  GET_CHAT_HISTORY: 'get-chat-history',
  CLEAR_CHAT_HISTORY: 'clear-chat-history',
  PLAY_VOICE_PREVIEW: 'play-voice-preview',

  // API Key Management
  SET_API_KEY: 'set-api-key',
  DELETE_API_KEY: 'delete-api-key',
  GET_API_KEY_STATUS: 'get-api-key-status',

  // Local Connection Management
  GET_LOCAL_CONNECTIONS: 'get-local-connections',
  ADD_LOCAL_CONNECTION: 'add-local-connection',
  UPDATE_LOCAL_CONNECTION: 'update-local-connection',
  DELETE_LOCAL_CONNECTION: 'delete-local-connection',
  TEST_LOCAL_CONNECTION: 'test-local-connection',
  GET_OLLAMA_MODELS: 'get-ollama-models',
  SET_LOCAL_CONNECTION_KEY: 'set-local-connection-key',
  DELETE_LOCAL_CONNECTION_KEY: 'delete-local-connection-key',

  // Ollama Model Management
  PULL_OLLAMA_MODEL: 'pull-ollama-model',
  OLLAMA_PULL_PROGRESS: 'ollama-pull-progress',
  OLLAMA_PULL_COMPLETE: 'ollama-pull-complete',
  OLLAMA_PULL_ERROR: 'ollama-pull-error',
  DELETE_OLLAMA_MODEL: 'delete-ollama-model',
  CREATE_OLLAMA_MODEL: 'create-ollama-model',
} as const;
