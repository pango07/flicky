import { app, systemPreferences, shell, desktopCapturer, clipboard } from 'electron';
import { ClaudeAPI } from './services/claude-api';
import { OpenAIAPI } from './services/openai-api';
import { OllamaAPI } from './services/ollama-api';
import { ElevenLabsTTS } from './services/elevenlabs-tts';
import { createTranscriptionProvider, type TranscriptionProvider } from './services/transcription';
import { captureAllDisplays } from './services/screen-capture';
import { parseAllPointTags, parseTypeTags, TAG_STRIP_REGEX } from './services/element-detector';
import { typeText, isAccessibilityGranted, promptAccessibility } from './services/auto-typer';
import { ContextManager } from './services/context-manager';
import * as settingsStore from './services/settings-store';
import * as keyStore from './services/key-store';
import * as chatHistory from './services/chat-history-store';
import * as analytics from './services/analytics';
import type {
  VoiceState,
  FlickySettings,
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  TranscriptionResult,
  Walkthrough,
  PttMode,
  TypeRequest,
  ScreenCapture,
  ApiKeyName,
  ReasoningDepth,
  ReplyTone,
  MemoryStats,
  ChatEntry,
  StreamVisibility,
  StreamWindowBounds,
} from '../shared/types';

export interface CompanionCallbacks {
  onVoiceStateChanged: (state: VoiceState) => void;
  onTranscriptUpdate: (result: TranscriptionResult) => void;
  onAiResponseChunk: (chunk: string) => void;
  onAiResponseComplete: (fullText: string) => void;
  onWalkthrough: (walkthrough: Walkthrough | null) => void;
  /** Active step index (0-based) inside the current walkthrough, or null when idle. */
  onWalkthroughStep: (index: number | null) => void;
  onTypeFulfilled: (request: TypeRequest) => void;
  onSettingsChanged: (settings: FlickySettings) => void;
  onMemoryStatsChanged: (stats: MemoryStats) => void;
  onChatEntryAdded: (entry: ChatEntry) => void;
  onStartAudioCapture: () => void;
  onStopAudioCapture: () => void;
  onPlayAudio: (audioBuffer: Buffer) => void;
  onCursorVisibilityChanged: (enabled: boolean) => void;
  onStreamVisibilityChanged: (v: StreamVisibility) => void;
}

export class CompanionManager {
  private callbacks: CompanionCallbacks;

  private claude: ClaudeAPI;
  private openai: OpenAIAPI;
  private ollama: OllamaAPI;
  private tts: ElevenLabsTTS;
  private context: ContextManager;
  private transcriptionProvider: TranscriptionProvider | null = null;

  private voiceState: VoiceState = 'idle';
  private lastScreenshots: ScreenCapture[] = [];
  private isRecording = false;

  /** Public read-only view used by main's PTT handler to keep its
   *  toggle state in sync after a failed start. */
  get recording(): boolean {
    return this.isRecording;
  }
  private reRegisterShortcut: ((accel: string) => boolean) | null = null;
  /**
   * Monotonic turn counter. A new PTT press bumps this; any still-running
   * LLM callbacks from the previous turn check if their captured id still
   * matches before they're allowed to mutate shared state.
   */
  private turnId = 0;
  private currentAbort: AbortController | null = null;
  /** Pending walkthrough step timers, cleared on new turn or end-of-walkthrough. */
  private walkthroughTimers: ReturnType<typeof setTimeout>[] = [];
  /**
   * If startRecording is in flight, other callers (typically a quick-release
   * stopPushToTalk) await this before deciding whether to stop. Without it,
   * stop can fire before `isRecording` has been flipped true, bail, and
   * leave the mic running forever.
   */
  private pendingStart: Promise<void> | null = null;

  constructor(callbacks: CompanionCallbacks) {
    this.callbacks = callbacks;
    this.claude = new ClaudeAPI();
    this.openai = new OpenAIAPI();
    this.ollama = new OllamaAPI();
    this.tts = new ElevenLabsTTS();
    this.context = new ContextManager();

    analytics.initAnalytics('', 'https://us.i.posthog.com');
    analytics.trackAppOpened();
  }

  // ── Settings ─────────────────────────────────────────────────────────

  getSettings(): FlickySettings {
    const stored = settingsStore.getAll();
    return {
      ...stored,
      apiKeyStatus: keyStore.getKeyStatus(),
    };
  }

  setModel(model: ClaudeModel): void {
    settingsStore.set('selectedModel', model);
    this.emitSettings();
  }

  setOpenAIModel(model: OpenAIModel): void {
    settingsStore.set('selectedOpenAIModel', model);
    this.emitSettings();
  }

  setMindProvider(provider: MindProvider): void {
    settingsStore.set('mindProvider', provider);
    this.emitSettings();
  }

  setReasoningDepth(depth: ReasoningDepth): void {
    settingsStore.set('reasoningDepth', depth);
    this.emitSettings();
  }

  setReplyTone(tone: ReplyTone): void {
    settingsStore.set('replyTone', tone);
    this.emitSettings();
  }

  setVoiceId(id: string): void {
    settingsStore.set('voiceId', id);
    this.emitSettings();
  }

  setVoiceSpeed(speed: number): void {
    settingsStore.set('voiceSpeed', speed);
    this.emitSettings();
  }

  setVoiceStability(stability: number): void {
    settingsStore.set('voiceStability', stability);
    this.emitSettings();
  }

  setSpeakReplies(enabled: boolean): void {
    settingsStore.set('speakReplies', enabled);
    this.emitSettings();
  }

  setGroqModel(model: GroqTranscriptionModel): void {
    settingsStore.set('groqTranscriptionModel', model);
    this.emitSettings();
  }

  toggleCursor(enabled: boolean): void {
    settingsStore.set('isClickyCursorEnabled', enabled);
    this.callbacks.onCursorVisibilityChanged(enabled);
    this.emitSettings();
  }

  setStreamVisibility(v: StreamVisibility): void {
    settingsStore.set('streamVisibility', v);
    this.callbacks.onStreamVisibilityChanged(v);
    this.emitSettings();
  }

  setStreamWindowBounds(b: StreamWindowBounds): void {
    settingsStore.set('streamWindowBounds', b);
    this.emitSettings();
  }

  setShortcutReRegister(fn: (accel: string) => boolean): void {
    this.reRegisterShortcut = fn;
  }

  setPushToTalkShortcut(accelerator: string): void {
    const previous = settingsStore.get('pushToTalkShortcut');
    if (!this.reRegisterShortcut) {
      settingsStore.set('pushToTalkShortcut', accelerator);
      this.emitSettings();
      return;
    }
    const ok = this.reRegisterShortcut(accelerator);
    if (ok) {
      settingsStore.set('pushToTalkShortcut', accelerator);
    } else {
      console.warn('[Flicky] Failed to register shortcut', accelerator, '— reverting to', previous);
      this.reRegisterShortcut(previous);
    }
    this.emitSettings();
  }

  setPttMode(mode: PttMode): void {
    settingsStore.set('pttMode', mode);
    this.emitSettings();
  }

  setAutoTypeEnabled(enabled: boolean): void {
    settingsStore.set('autoTypeEnabled', enabled);
    // Flipping the toggle on is the right moment to nudge the user
    // through the macOS Accessibility prompt — they just expressed
    // intent to grant. No-op on other platforms / when already trusted.
    if (enabled && !isAccessibilityGranted()) {
      promptAccessibility();
    }
    this.emitSettings();
  }

  setLaunchAtLogin(enabled: boolean): void {
    settingsStore.set('launchAtLogin', enabled);
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (err) {
      console.error('[Flicky] setLoginItemSettings failed:', err);
    }
    this.emitSettings();
  }

  completeOnboarding(): void {
    settingsStore.set('onboardingComplete', true);
    this.emitSettings();
  }

  replayOnboarding(): void {
    settingsStore.set('onboardingComplete', false);
    analytics.trackOnboardingReplayed();
    this.emitSettings();
  }

  // ── Context / Memory ─────────────────────────────────────────────────

  clearContext(): void {
    this.context.clear();
    this.emitMemoryStats();
  }

  async compactContext(): Promise<{ ok: boolean; error?: string }> {
    if (!this.context.canCompact()) {
      return { ok: false, error: 'Need at least two exchanges before compacting.' };
    }
    try {
      await this.context.compact(true);
      this.emitMemoryStats();
      return { ok: true };
    } catch (err) {
      this.emitMemoryStats();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getMemoryStats(): MemoryStats {
    return this.context.getStats();
  }

  // ── Chat history ─────────────────────────────────────────────────────

  getChatHistory(): ChatEntry[] {
    return chatHistory.getAll();
  }

  clearChatHistory(): void {
    chatHistory.clear();
  }

  // ── API Keys ─────────────────────────────────────────────────────────

  setApiKey(name: ApiKeyName, value: string): void {
    keyStore.setApiKey(name, value);
    this.emitSettings();
  }

  deleteApiKey(name: ApiKeyName): void {
    keyStore.deleteApiKey(name);
    this.emitSettings();
  }

  getApiKeyStatus(): Record<ApiKeyName, boolean> {
    return keyStore.getKeyStatus();
  }

  // ── TTS preview ──────────────────────────────────────────────────────

  async playVoicePreview(voiceId: string): Promise<void> {
    try {
      const buf = await this.tts.synthesize(
        "hi, i'm flicky. i'll be using this voice to talk with you.",
        {
          voiceId,
          speed: settingsStore.get('voiceSpeed'),
          stability: settingsStore.get('voiceStability'),
        },
      );
      this.callbacks.onPlayAudio(buf);
    } catch (err) {
      console.error('[Flicky] voice preview failed:', err);
    }
  }

  // ── Permissions ──────────────────────────────────────────────────────

  async getPermissions(): Promise<Record<string, boolean>> {
    const perms: Record<string, boolean> = {
      microphone: false,
      screen: false,
      accessibility: false,
    };
    if (process.platform === 'darwin') {
      perms.microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted';
      perms.screen = systemPreferences.getMediaAccessStatus('screen') === 'granted';
      perms.accessibility = isAccessibilityGranted();
    } else {
      perms.microphone = true;
      perms.screen = true;
      perms.accessibility = true;
    }
    return perms;
  }

  async requestPermission(kind: string): Promise<void> {
    if (process.platform !== 'darwin') return;

    if (kind === 'microphone') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'not-determined') {
        await systemPreferences.askForMediaAccess('microphone');
      } else if (status === 'denied' || status === 'restricted') {
        // The OS only shows the prompt once; after denial the user must
        // re-enable us in System Settings. Deeplink straight to the pane.
        shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        );
      }
      return;
    }

    if (kind === 'accessibility') {
      // Calling with `true` adds Flicky to the Accessibility list and
      // surfaces the OS dialog. The user still has to flip the checkbox
      // themselves; we deeplink to the right pane in case the dialog
      // got dismissed.
      promptAccessibility();
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
      return;
    }

    if (kind === 'screen') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'not-determined') {
        // No askForMediaAccess equivalent for screen — but actually
        // *attempting* a capture provokes the system prompt the first time.
        try {
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
          });
        } catch (err) {
          console.error('[Flicky] screen permission probe failed:', err);
        }
      } else if (status === 'denied' || status === 'restricted') {
        shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        );
      }
    }
  }

  // ── Push-to-Talk Pipeline ────────────────────────────────────────────

  async handlePushToTalk(): Promise<void> {
    if (this.isRecording) await this.stopRecordingAndProcess();
    else await this.startRecording();
  }

  async startPushToTalk(): Promise<void> {
    if (this.isRecording || this.pendingStart) return;
    const p = this.startRecording();
    this.pendingStart = p;
    try {
      await p;
    } finally {
      if (this.pendingStart === p) this.pendingStart = null;
    }
  }

  async stopPushToTalk(): Promise<void> {
    // If a start is still in flight, let it finish so isRecording flips
    // true before we decide whether to stop. Otherwise a quick press/release
    // can race past the start and leak a live mic.
    if (this.pendingStart) {
      try { await this.pendingStart; } catch { /* surfaced inside startRecording */ }
    }
    if (!this.isRecording) return;
    await this.stopRecordingAndProcess();
  }

  private clearWalkthroughTimers(): void {
    for (const t of this.walkthroughTimers) clearTimeout(t);
    this.walkthroughTimers = [];
  }

  /**
   * Schedule a walkthrough so overlay + stream + any other surface stay
   * in lockstep. Emits the full step list once, then a step index per
   * step at computed times, then clears with `null` after the last step.
   *
   * Per-step dwell scales with caption length so longer instructions
   * stay on screen long enough to read; floor of 2.6s, ceiling of 5.5s.
   */
  private startWalkthrough(walkthrough: Walkthrough, isCurrent: () => boolean): void {
    this.clearWalkthroughTimers();
    this.callbacks.onWalkthrough(walkthrough);

    const dwellFor = (label: string): number =>
      Math.max(2600, Math.min(5500, 1800 + label.length * 80));

    let cursor = 0;
    walkthrough.steps.forEach((step, i) => {
      const start = cursor;
      const t = setTimeout(() => {
        if (!isCurrent()) return;
        this.callbacks.onWalkthroughStep(i);
      }, start);
      this.walkthroughTimers.push(t);
      cursor += dwellFor(step.label);
    });

    // After the last step has had its dwell, clear the walkthrough.
    const endTimer = setTimeout(() => {
      if (!isCurrent()) return;
      this.callbacks.onWalkthroughStep(null);
      this.callbacks.onWalkthrough(null);
    }, cursor);
    this.walkthroughTimers.push(endTimer);
  }

  private async startRecording(): Promise<void> {
    // Bump the turn and abort any in-flight work from the previous one
    // so the user's new message supersedes whatever Flicky was doing.
    this.turnId += 1;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.clearWalkthroughTimers();
    this.callbacks.onWalkthrough(null);
    this.callbacks.onWalkthroughStep(null);

    this.isRecording = true;
    this.setVoiceState('listening');
    analytics.trackPushToTalkStarted();

    const provider = settingsStore.get('transcriptionProvider');
    this.transcriptionProvider = createTranscriptionProvider(provider);

    this.transcriptionProvider.onPartialTranscript = (text) => {
      this.callbacks.onTranscriptUpdate({ text, isFinal: false });
    };

    try {
      await this.transcriptionProvider.start();
      this.callbacks.onStartAudioCapture();
    } catch (err) {
      console.error('Failed to start transcription:', err);
      this.setVoiceState('idle');
      this.isRecording = false;
    }
  }

  private async stopRecordingAndProcess(): Promise<void> {
    this.isRecording = false;
    this.callbacks.onStopAudioCapture();
    analytics.trackPushToTalkReleased();

    if (!this.transcriptionProvider) {
      this.setVoiceState('idle');
      return;
    }

    const result = await this.transcriptionProvider.stop();
    this.transcriptionProvider = null;

    if (!result.text.trim()) {
      this.setVoiceState('idle');
      return;
    }

    this.callbacks.onTranscriptUpdate(result);
    analytics.trackUserMessageSent(result.text);

    this.setVoiceState('processing');
    try {
      this.lastScreenshots = await captureAllDisplays();
    } catch (err) {
      console.error('Screen capture failed:', err);
      this.lastScreenshots = [];
    }
    if (this.lastScreenshots.length === 0) {
      // Almost always means Screen Recording permission is missing on
      // macOS — desktopCapturer returns empty thumbnails in that case.
      // Surface a friendly response instead of letting an empty image
      // 400 the upstream LLM call. Synthesize TTS too so the user
      // hears the error even if their attention is on a different
      // window than the panel.
      const settings = settingsStore.getAll();
      const msg = process.platform === 'darwin'
        ? "i can't see your screen right now — give flicky screen recording permission in system settings, then quit and reopen the app."
        : "i can't see your screen right now — screen capture failed.";
      this.callbacks.onAiResponseChunk(msg);
      this.callbacks.onAiResponseComplete(msg);
      if (settings.speakReplies && keyStore.getKeyStatus().elevenlabs) {
        this.setVoiceState('responding');
        try {
          const audioBuffer = await this.tts.synthesize(msg, {
            voiceId: settings.voiceId,
            speed: settings.voiceSpeed,
            stability: settings.voiceStability,
          });
          this.callbacks.onPlayAudio(audioBuffer);
        } catch (err) {
          console.error('TTS error on screen-capture failure path:', err);
        }
      }
      this.setVoiceState('idle');
      return;
    }

    const settings = settingsStore.getAll();
    const myTurnId = this.turnId;
    const abort = new AbortController();
    this.currentAbort = abort;
    // Stay in 'processing' until TTS audio is ready to play (or the
    // reply completes without TTS). The UI shows its spinner during
    // this state, so this keeps the spinner visible for the full
    // think + stream + synthesize span instead of flashing for a
    // few ms during screenshot capture only.

    // Every side effect below is gated on the turn id. If the user has
    // already started a new PTT by the time an async callback resolves,
    // we drop the callback on the floor — no stale UI mutations, no
    // stale chat entries, no TTS we'd have to kill on arrival.
    const isCurrent = () => this.turnId === myTurnId;

    const mindCallbacks = {
      onChunk: (chunk: string) => {
        if (!isCurrent()) return;
        this.callbacks.onAiResponseChunk(chunk);
      },
      onComplete: async (
        fullText: string,
        usage?: { inputTokens: number; outputTokens: number },
      ) => {
        if (!isCurrent()) return;
        analytics.trackAiResponseReceived(fullText);

        const cleanText = fullText.replace(TAG_STRIP_REGEX, '').trim();
        this.callbacks.onAiResponseComplete(cleanText);

        await this.context.recordExchange(result.text, cleanText, {
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        });
        if (!isCurrent()) return;
        this.emitMemoryStats();

        const entry = chatHistory.append({
          userText: result.text,
          assistantText: cleanText,
        });
        this.callbacks.onChatEntryAdded(entry);

        const walkthrough = parseAllPointTags(fullText, this.lastScreenshots);
        if (walkthrough) {
          console.log(
            `[Flicky] Walkthrough: ${walkthrough.steps.length} step(s) →`,
            walkthrough.steps.map((s) => `${s.step}/${s.total} "${s.label}"`).join(', '),
          );
          this.startWalkthrough(walkthrough, isCurrent);
          analytics.trackElementPointed(
            walkthrough.steps.length > 1
              ? `${walkthrough.steps[0].label} (+${walkthrough.steps.length - 1} more)`
              : walkthrough.steps[0].label,
          );
        }

        // [TYPE:...] tags. If the user has opted into auto-typing AND
        // the OS permission is in place, we send the keys directly via
        // the native typer; otherwise we fall back to clipboard handoff.
        // typeText() returns false on any failure so the user is never
        // left with no way to act on the request.
        const typeTexts = parseTypeTags(fullText);
        for (const text of typeTexts) {
          if (!text) continue;
          const preview = text.length > 50 ? `${text.slice(0, 50)}…` : text;
          let autoTyped = false;
          if (settings.autoTypeEnabled) {
            autoTyped = await typeText(text);
          }
          if (!autoTyped) {
            clipboard.writeText(text);
          }
          console.log(
            `[Flicky] Type request → ${autoTyped ? 'auto-typed' : 'clipboard'}: "${preview}"`,
          );
          this.callbacks.onTypeFulfilled({ text, preview, autoTyped });
        }

        if (settings.speakReplies && keyStore.getKeyStatus().elevenlabs) {
          try {
            const audioBuffer = await this.tts.synthesize(cleanText, {
              voiceId: settings.voiceId,
              speed: settings.voiceSpeed,
              stability: settings.voiceStability,
            });
            // User may have started a new turn while TTS was synthesizing;
            // don't play an answer they no longer want to hear.
            if (!isCurrent()) return;
            this.setVoiceState('responding');
            this.callbacks.onPlayAudio(audioBuffer);
          } catch (err) {
            console.error('TTS error:', err);
            analytics.trackTtsError(String(err));
          }
        }

        if (!isCurrent()) return;
        this.setVoiceState('idle');
      },
      onError: (err: Error) => {
        if (!isCurrent()) return;
        console.error('Mind provider error:', err);
        analytics.trackResponseError(err.message);
        this.setVoiceState('idle');
      },
    };

    const mindOptions = {
      reasoningDepth: settings.reasoningDepth,
      replyTone: settings.replyTone,
      signal: abort.signal,
    };

    if (settings.mindProvider === 'openai') {
      await this.openai.streamChat(
        result.text,
        this.lastScreenshots,
        this.context.getMessagesForSend(),
        settings.selectedOpenAIModel,
        mindOptions,
        mindCallbacks,
      );
    } else if (settings.mindProvider === 'ollama') {
      const connections = (settings.localConnections ?? []).filter((c) => c.enabled);
      const conn = connections[0];
      if (!conn) {
        mindCallbacks.onError(new Error('No enabled local connection. Add one in Mind → Local.'));
        return;
      }
      const bearerToken = keyStore.getApiKey(`local_${conn.id}`) ?? undefined;
      let model: string;
      if (conn.activeModelId) {
        model = conn.activeModelId;
      } else if (conn.modelIds.length > 0) {
        model = conn.modelIds[0];
      } else {
        const discovered = await this.ollama.getModels(conn.url, bearerToken);
        model = discovered[0] ?? 'llama3';
      }
      const fullModelId = conn.prefixId ? `${conn.prefixId}${model}` : model;
      await this.ollama.streamChat(
        result.text,
        this.lastScreenshots,
        this.context.getMessagesForSend(),
        fullModelId,
        { replyTone: mindOptions.replyTone, signal: mindOptions.signal },
        mindCallbacks,
        conn.url,
        bearerToken,
      );
    } else {
      await this.claude.streamChat(
        result.text,
        this.lastScreenshots,
        this.context.getMessagesForSend(),
        settings.selectedModel,
        mindOptions,
        mindCallbacks,
      );
    }

    if (this.currentAbort === abort) this.currentAbort = null;
  }

  handleAudioChunk(buffer: Buffer): void {
    this.transcriptionProvider?.sendAudio(buffer);
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setVoiceState(state: VoiceState): void {
    this.voiceState = state;
    this.callbacks.onVoiceStateChanged(state);
  }

  private emitSettings(): void {
    this.callbacks.onSettingsChanged(this.getSettings());
  }

  private emitMemoryStats(): void {
    this.callbacks.onMemoryStatsChanged(this.context.getStats());
  }
}
