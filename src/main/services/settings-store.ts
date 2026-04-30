import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic } from './fs-util';
import type {
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  TranscriptionProviderType,
  ReasoningDepth,
  ReplyTone,
  StreamVisibility,
  StreamWindowBounds,
  LocalConnection,
  PttMode,
} from '../../shared/types';

/**
 * Simple JSON-file settings store.
 * Avoids the ESM-only `electron-store` v10 compatibility issues.
 */

export interface StoredSettings {
  mindProvider: MindProvider;
  selectedModel: ClaudeModel;
  selectedOpenAIModel: OpenAIModel;
  reasoningDepth: ReasoningDepth;
  replyTone: ReplyTone;

  voiceId: string;
  voiceSpeed: number;
  voiceStability: number;
  speakReplies: boolean;

  groqTranscriptionModel: GroqTranscriptionModel;
  transcriptionProvider: TranscriptionProviderType;

  isClickyCursorEnabled: boolean;
  launchAtLogin: boolean;
  pushToTalkShortcut: string;
  pttMode: PttMode;
  autoTypeEnabled: boolean;
  streamVisibility: StreamVisibility;
  streamWindowBounds: StreamWindowBounds | null;

  localConnections: LocalConnection[];

  onboardingComplete: boolean;
}

const DEFAULTS: StoredSettings = {
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
  // Default to 'toggle' on macOS because Electron's globalShortcut on
  // darwin can't detect key-up; 'hold' would record forever there.
  pttMode: process.platform === 'darwin' ? 'toggle' : 'hold',
  autoTypeEnabled: false,
  streamVisibility: 'off',
  streamWindowBounds: null,

  localConnections: [],

  onboardingComplete: false,
};

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'flicky-settings.json');
}

/**
 * In-memory cache. The settings file is the single source of truth across
 * runs, but within a run we own it — no external writers — so re-reading
 * disk on every `get`/`set` is wasted I/O. We hydrate once on first access
 * and keep the cache in sync with every `set`.
 */
let cache: StoredSettings | null = null;

function readDisk(): StoredSettings {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function ensureLoaded(): StoredSettings {
  if (cache === null) cache = readDisk();
  return cache;
}

function write(data: StoredSettings): void {
  writeFileAtomic(getFilePath(), JSON.stringify(data, null, 2));
}

export function get<K extends keyof StoredSettings>(key: K): StoredSettings[K] {
  return ensureLoaded()[key];
}

export function set<K extends keyof StoredSettings>(key: K, value: StoredSettings[K]): void {
  const data = ensureLoaded();
  data[key] = value;
  // Persist after mutating the cache. If the disk write fails we still
  // have the new value in memory for the rest of the session — the next
  // launch will revert, which matches the previous behavior.
  write(data);
}

export function getAll(): StoredSettings {
  // Shallow copy so callers can't mutate the cache through the returned ref.
  return { ...ensureLoaded() };
}
