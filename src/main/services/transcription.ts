import type { TranscriptionResult, TranscriptionProviderType } from '../../shared/types';
import { getApiKey } from './key-store';
import * as settingsStore from './settings-store';

// ── Provider Interface ─────────────────────────────────────────────────

export interface TranscriptionProvider {
  start(): Promise<void>;
  stop(): Promise<TranscriptionResult>;
  sendAudio(pcm16Buffer: Buffer): void;
  onPartialTranscript?: (text: string) => void;
}

// ── Groq Whisper Provider ──────────────────────────────────────────────

export class GroqWhisperProvider implements TranscriptionProvider {
  private audioChunks: Buffer[] = [];
  onPartialTranscript?: (text: string) => void;

  async start(): Promise<void> {
    const apiKey = getApiKey('groq');
    if (!apiKey) throw new Error('Groq API key not configured. Add it in the Flicky panel.');
    this.audioChunks = [];
  }

  sendAudio(pcm16Buffer: Buffer): void {
    this.audioChunks.push(pcm16Buffer);
  }

  async stop(): Promise<TranscriptionResult> {
    const pcmData = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    // 16000 Hz * 2 bytes per sample * 0.1s = 3200 bytes minimum
    if (pcmData.length < 3200) {
      return { text: '', isFinal: true };
    }

    const wavBuffer = buildWav(pcmData, 16000, 1, 16);

    const model = settingsStore.get('groqTranscriptionModel');

    const formData = new FormData();
    const arrayBuf = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
    formData.append('file', new Blob([arrayBuf], { type: 'audio/wav' }), 'recording.wav');
    formData.append('model', model);
    // English-only locks Whisper out of language detection (which is the
    // single biggest source of garbled output on short voice clips). If
    // we ever want multilingual, lift this from the user's locale.
    formData.append('language', 'en');
    // Temperature 0 = deterministic decoding. Higher temps invent words
    // when the audio is unclear; for short commands we want fewer halluc-
    // inations, even if it means cutting an unintelligible word.
    formData.append('temperature', '0');
    // The "prompt" biases the model's vocab. Loading it with the kind
    // of words a user actually says to a screen-aware assistant fixes a
    // lot of the weirdness — proper-noun apps ("Slack", "Notion"),
    // pointing verbs ("click", "highlight"), and generic UI nouns get
    // far higher prior probability and stop being mis-transcribed as
    // homophones (e.g. "click" → "clique"). Whisper accepts up to 224
    // tokens here; keep it short and dense.
    formData.append(
      'prompt',
      "Flicky, click, tap, open, close, switch, highlight, select, search, paste, file, folder, window, tab, button, link, screen, cursor, Slack, Chrome, Notion, VS Code, Figma, Gmail.",
    );

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey('groq')}`,
      },
      body: formData,
    });

    if (!res.ok) throw new Error(`Groq transcription error ${res.status}: ${await res.text()}`);
    const result = (await res.json()) as { text: string };

    return { text: result.text, isFinal: true };
  }
}

// ── OpenAI Whisper Provider (upload-based fallback) ────────────────────

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private audioChunks: Buffer[] = [];
  onPartialTranscript?: (text: string) => void;

  async start(): Promise<void> {
    const apiKey = getApiKey('anthropic'); // Uses OpenAI-compatible key — user may supply separately
    if (!apiKey) throw new Error('API key not configured for transcription.');
    this.audioChunks = [];
  }

  sendAudio(pcm16Buffer: Buffer): void {
    this.audioChunks.push(pcm16Buffer);
  }

  async stop(): Promise<TranscriptionResult> {
    // Build WAV from accumulated PCM16 chunks
    const pcmData = Buffer.concat(this.audioChunks);
    const wavBuffer = buildWav(pcmData, 16000, 1, 16);

    const formData = new FormData();
    const arrayBuf = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
    formData.append('file', new Blob([arrayBuf], { type: 'audio/wav' }), 'recording.wav');
    formData.append('model', 'gpt-4o-transcribe');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey('anthropic')}`, // Would need a separate OpenAI key in production
      },
      body: formData,
    });

    if (!res.ok) throw new Error(`Whisper transcription error ${res.status}`);
    const result = (await res.json()) as { text: string };
    this.audioChunks = [];

    return { text: result.text, isFinal: true };
  }
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTranscriptionProvider(
  type: TranscriptionProviderType,
): TranscriptionProvider {
  switch (type) {
    case 'groq':
      return new GroqWhisperProvider();
    case 'openai':
      return new OpenAIWhisperProvider();
    case 'native':
    default:
      // Fall back to Groq for unknown/legacy provider values (e.g. 'assemblyai').
      return new GroqWhisperProvider();
  }
}

// ── WAV Builder ────────────────────────────────────────────────────────

function buildWav(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(headerSize - 8 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, headerSize);

  return buffer;
}
