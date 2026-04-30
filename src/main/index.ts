import { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage } from 'electron';
import path from 'path';
import { CompanionManager } from './companion-manager';
import { createPanelWindow, createOverlayWindow, createStreamWindow } from './windows';
import { IPC, type StreamVisibility, type StreamWindowBounds, type LocalConnection } from '../shared/types';
import { AUDIO_IPC } from './services/audio-capture';
import * as chatHistory from './services/chat-history-store';
import * as settingsStore from './services/settings-store';
import { setApiKey, getApiKey, deleteApiKey } from './services/key-store';
import { OllamaAPI } from './services/ollama-api';
import { randomUUID } from 'crypto';

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let tray: Tray | null = null;
let panelWindow: BrowserWindow | null = null;
let overlayWindows: BrowserWindow[] = [];
let streamWindow: BrowserWindow | null = null;
let companion: CompanionManager;
let isAppQuitting = false;
let lastVoiceState = 'idle';
/** Whether a walkthrough is currently playing (steps 1..N animating). */
let walkthroughActive = false;

app.on('before-quit', () => { isAppQuitting = true; });

// ── Helpers ────────────────────────────────────────────────────────────

function createTrayIcon(): Electron.NativeImage {
  // Resolve the icon relative to the built JS. In dev that's
  // dist/main/main/ → ../../../assets; in a packaged app the same
  // path resolves inside the asar bundle since assets/** is shipped.
  const assetRoot = path.join(__dirname, '../../../assets');
  const size32 = path.join(assetRoot, 'icons', '32x32.png');
  const size16 = path.join(assetRoot, 'icons', '16x16.png');

  const primary = process.platform === 'darwin' ? size32 : size16;

  try {
    const img = nativeImage.createFromPath(primary);
    if (img.isEmpty()) throw new Error('empty tray icon image');

    // On macOS attach a 2x representation so the tray icon stays
    // crisp on Retina. On Windows/Linux resize to 16 for the tray.
    if (process.platform === 'darwin') {
      const hi = nativeImage.createFromPath(size32);
      if (!hi.isEmpty()) {
        img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
      }
      return img.resize({ width: 16, height: 16 });
    }
    return img.resize({ width: 16, height: 16 });
  } catch (err) {
    console.error('[Flicky] tray icon load failed, using fallback:', err);
    // Generated fallback — cornflower-blue filled circle so the tray
    // entry is still clickable even if the PNGs are missing.
    const size = 32;
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = size / 2, cy = size / 2, r = size / 2 - 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const i = (y * size + x) * 4;
        if (dist <= r) {
          canvas[i] = 100;
          canvas[i + 1] = 149;
          canvas[i + 2] = 237;
          canvas[i + 3] = 255;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }
}

function sendToPanel(channel: string, ...args: unknown[]): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, ...args);
  }
}

function sendToOverlays(channel: string, ...args: unknown[]): void {
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

/**
 * Pick a single overlay to receive an event. Used for things that must
 * not duplicate across displays — TTS audio playback being the canonical
 * case (broadcasting to all overlays plays the buffer once per display
 * and audibly doubles).
 */
function sendToOneOverlay(channel: string, ...args: unknown[]): void {
  const target = overlayWindows.find((w) => !w.isDestroyed());
  if (target) target.webContents.send(channel, ...args);
}

function sendToStream(channel: string, ...args: unknown[]): void {
  if (streamWindow && !streamWindow.isDestroyed()) {
    streamWindow.webContents.send(channel, ...args);
  }
}

function sendToAll(channel: string, ...args: unknown[]): void {
  sendToPanel(channel, ...args);
  sendToOverlays(channel, ...args);
  sendToStream(channel, ...args);
}

// ── App Lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialize companion manager
  companion = new CompanionManager({
    onVoiceStateChanged: (state) => {
      lastVoiceState = state;
      sendToAll(IPC.VOICE_STATE_CHANGED, state);
      updateStreamForVoiceState(state);
    },
    onTranscriptUpdate: (result) => sendToAll(IPC.TRANSCRIPT_UPDATE, result),
    onAiResponseChunk: (chunk) => {
      sendToPanel(IPC.AI_RESPONSE_CHUNK, chunk);
      sendToStream(IPC.AI_RESPONSE_CHUNK, chunk);
    },
    onAiResponseComplete: (text) => {
      sendToPanel(IPC.AI_RESPONSE_COMPLETE, text);
      sendToStream(IPC.AI_RESPONSE_COMPLETE, text);
    },
    onWalkthrough: (w) => {
      walkthroughActive = !!w;
      sendToOverlays(IPC.WALKTHROUGH, w);
      sendToStream(IPC.WALKTHROUGH, w);
      // Keep the stream visible across the walkthrough in 'responses' mode,
      // even after voice state has returned to idle. When the walkthrough
      // ends we re-evaluate based on the current voice state.
      if (w) applyStreamVisibility(companion.getSettings().streamVisibility);
      else updateStreamForVoiceState(lastVoiceState);
    },
    onWalkthroughStep: (i) => {
      sendToOverlays(IPC.WALKTHROUGH_STEP, i);
      sendToStream(IPC.WALKTHROUGH_STEP, i);
    },
    onTypeFulfilled: (req) => {
      // Toast goes on a single overlay (cursor display) so the user
      // sees one notification, not one per monitor.
      sendToOneOverlay(IPC.TYPE_FULFILLED, req);
      sendToStream(IPC.TYPE_FULFILLED, req);
    },
    onSettingsChanged: (s) => sendToPanel(IPC.SETTINGS_CHANGED, s),
    onMemoryStatsChanged: (stats) => sendToPanel(IPC.MEMORY_STATS, stats),
    onChatEntryAdded: (entry) => sendToPanel(IPC.CHAT_ENTRY_ADDED, entry),
    onStartAudioCapture: () => sendToOverlays(AUDIO_IPC.START_CAPTURE),
    onStopAudioCapture: () => sendToOverlays(AUDIO_IPC.STOP_CAPTURE),
    onPlayAudio: (buf) => sendToOneOverlay('play-audio', buf),
    onCursorVisibilityChanged: (enabled) => applyOverlayVisibility(enabled),
    onStreamVisibilityChanged: (v) => applyStreamVisibility(v),
  });

  // Create tray
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Flicky');

  console.log('[Flicky] Tray created, registering click handler...');

  tray.on('click', () => togglePanel());
  tray.on('double-click', () => togglePanel());

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Panel', click: () => { console.log('[Flicky] Show Panel menu clicked'); togglePanel(); } },
      { type: 'separator' },
      { label: 'Quit Flicky', click: () => app.quit() },
    ]),
  );

  // Create overlay windows for each display
  rebuildOverlays();
  screen.on('display-added', rebuildOverlays);
  screen.on('display-removed', rebuildOverlays);

  // Create the transparent stream window (hidden until the user opts in).
  {
    const settings = companion.getSettings();
    streamWindow = createStreamWindow(settings.streamWindowBounds);
    streamWindow.on('close', (e) => {
      // Don't let the user actually close the stream — just hide it and
      // flip the setting off so the toggle in General reflects reality.
      if (!isAppQuitting) {
        e.preventDefault();
        streamWindow?.hide();
        companion.setStreamVisibility('off');
      }
    });
    streamWindow.on('moved', persistStreamBounds);
    streamWindow.on('resized', persistStreamBounds);
    applyStreamVisibility(settings.streamVisibility);
  }

  // Sync the OS login-item state with our stored preference. Handles
  // the case where the user disables the login item externally (e.g.
  // via System Settings) — next launch reconciles the two.
  try {
    app.setLoginItemSettings({ openAtLogin: companion.getSettings().launchAtLogin });
  } catch (err) {
    console.error('[Flicky] initial setLoginItemSettings failed:', err);
  }

  // Register global push-to-talk shortcut.
  //
  // Two modes, chosen by the `pttMode` setting:
  //   'hold'   — Windows/Linux only. globalShortcut fires repeatedly on
  //              OS key-repeat while the accelerator is held; we start on
  //              the first fire and stop after 250 ms of silence (release).
  //   'toggle' — first tap starts, second tap stops. Required on macOS,
  //              where globalShortcut fires exactly once per press and
  //              Electron exposes no key-up event.
  //
  // On macOS we always behave as 'toggle' regardless of the stored setting,
  // so a user who set 'hold' on another platform doesn't get a stuck mic.
  const isMac = process.platform === 'darwin';
  let pttDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pttActive = false;
  let currentShortcut = '';

  const pttHandler = () => {
    const mode = isMac ? 'toggle' : companion.getSettings().pttMode;

    if (mode === 'toggle') {
      if (!pttActive) {
        pttActive = true;
        companion.startPushToTalk();
      } else {
        pttActive = false;
        companion.stopPushToTalk();
      }
      return;
    }

    // 'hold' mode (Windows/Linux): rely on key-repeat, debounce on silence.
    if (pttDebounceTimer) {
      clearTimeout(pttDebounceTimer);
      pttDebounceTimer = null;
    }
    if (!pttActive) {
      pttActive = true;
      companion.startPushToTalk();
    }
    pttDebounceTimer = setTimeout(() => {
      pttActive = false;
      pttDebounceTimer = null;
      companion.stopPushToTalk();
    }, 250);
  };

  function registerPttShortcut(accelerator: string): boolean {
    const previous = currentShortcut;
    try {
      if (previous) globalShortcut.unregister(previous);
      const ok = globalShortcut.register(accelerator, pttHandler);
      if (ok) {
        currentShortcut = accelerator;
        return true;
      }
    } catch (err) {
      console.error('[Flicky] shortcut register failed:', err);
    }
    // Failure path: always try to restore the last-known-good binding so
    // the user isn't left without any shortcut at all, even when the
    // failing register call used the same accelerator as before.
    if (previous) {
      try {
        globalShortcut.register(previous, pttHandler);
        currentShortcut = previous;
      } catch (err) {
        console.error('[Flicky] shortcut rollback failed:', err);
        currentShortcut = '';
      }
    }
    return false;
  }

  registerPttShortcut(companion.getSettings().pushToTalkShortcut);
  companion.setShortcutReRegister(registerPttShortcut);

  function suspendPttShortcut(): void {
    if (currentShortcut) {
      try { globalShortcut.unregister(currentShortcut); } catch { /* no-op */ }
    }
  }
  function resumePttShortcut(): void {
    const desired = companion.getSettings().pushToTalkShortcut;
    registerPttShortcut(desired);
  }
  ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, () => suspendPttShortcut());
  ipcMain.on(IPC.RESUME_PUSH_TO_TALK_SHORTCUT, () => resumePttShortcut());

  // ── IPC Handlers ───────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_SETTINGS, () => companion.getSettings());
  ipcMain.handle(IPC.GET_PERMISSIONS, () => companion.getPermissions());

  ipcMain.on(IPC.SET_MODEL, (_e, model) => companion.setModel(model));
  ipcMain.on(IPC.SET_OPENAI_MODEL, (_e, model) => companion.setOpenAIModel(model));
  ipcMain.on(IPC.SET_MIND_PROVIDER, (_e, provider) => companion.setMindProvider(provider));
  ipcMain.on(IPC.SET_REASONING_DEPTH, (_e, depth) => companion.setReasoningDepth(depth));
  ipcMain.on(IPC.SET_REPLY_TONE, (_e, tone) => companion.setReplyTone(tone));
  ipcMain.on(IPC.SET_VOICE_ID, (_e, id) => companion.setVoiceId(id));
  ipcMain.on(IPC.SET_VOICE_SPEED, (_e, speed) => companion.setVoiceSpeed(speed));
  ipcMain.on(IPC.SET_VOICE_STABILITY, (_e, stab) => companion.setVoiceStability(stab));
  ipcMain.on(IPC.SET_SPEAK_REPLIES, (_e, enabled) => companion.setSpeakReplies(enabled));
  ipcMain.on(IPC.TOGGLE_CURSOR, (_e, enabled) => companion.toggleCursor(enabled));
  ipcMain.on(IPC.SET_LAUNCH_AT_LOGIN, (_e, enabled) => companion.setLaunchAtLogin(enabled));
  ipcMain.on(IPC.SET_PUSH_TO_TALK_SHORTCUT, (_e, accel: string) => companion.setPushToTalkShortcut(accel));
  ipcMain.on(IPC.SET_PTT_MODE, (_e, mode) => companion.setPttMode(mode));
  ipcMain.on(IPC.SET_AUTO_TYPE_ENABLED, (_e, enabled: boolean) => companion.setAutoTypeEnabled(enabled));
  ipcMain.on(IPC.SET_STREAM_VISIBILITY, (_e, v: StreamVisibility) => companion.setStreamVisibility(v));
  ipcMain.on(IPC.SET_STREAM_WINDOW_BOUNDS, (_e, b: StreamWindowBounds) => companion.setStreamWindowBounds(b));
  ipcMain.on(IPC.CLEAR_STREAM, () => sendToStream(IPC.CLEAR_STREAM));
  ipcMain.on(IPC.REQUEST_PERMISSION, (_e, kind) => companion.requestPermission(kind));
  ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url) => shell.openExternal(url));
  ipcMain.on(IPC.QUIT_APP, () => app.quit());
  ipcMain.on(IPC.REPLAY_ONBOARDING, () => companion.replayOnboarding());
  ipcMain.on(IPC.COMPLETE_ONBOARDING, () => companion.completeOnboarding());
  ipcMain.on(IPC.SET_GROQ_MODEL, (_e, model) => companion.setGroqModel(model));
  ipcMain.on(IPC.CLEAR_CONTEXT, () => companion.clearContext());
  ipcMain.handle(IPC.COMPACT_CONTEXT, () => companion.compactContext());
  ipcMain.on(IPC.PLAY_VOICE_PREVIEW, (_e, voiceId) => { void companion.playVoicePreview(voiceId); });
  ipcMain.handle(IPC.GET_MEMORY_STATS, () => companion.getMemoryStats());
  ipcMain.handle(IPC.GET_CHAT_HISTORY, () => companion.getChatHistory());
  ipcMain.on(IPC.CLEAR_CHAT_HISTORY, () => companion.clearChatHistory());

  // API Key Management
  ipcMain.on(IPC.SET_API_KEY, (_e, name, value) => companion.setApiKey(name, value));
  ipcMain.on(IPC.DELETE_API_KEY, (_e, name) => companion.deleteApiKey(name));
  ipcMain.handle(IPC.GET_API_KEY_STATUS, () => companion.getApiKeyStatus());

  // Local Connection Management
  const ollamaAPI = new OllamaAPI();

  function emitLocalConnections(): void {
    const settings = companion.getSettings();
    sendToPanel(IPC.SETTINGS_CHANGED, settings);
  }

  ipcMain.handle(IPC.GET_LOCAL_CONNECTIONS, () => {
    return settingsStore.get('localConnections') ?? [];
  });

  ipcMain.handle(IPC.ADD_LOCAL_CONNECTION, (_e, conn: Omit<LocalConnection, 'id'>) => {
    const connections = settingsStore.get('localConnections') ?? [];
    const newConn: LocalConnection = { ...conn, id: randomUUID() };
    settingsStore.set('localConnections', [...connections, newConn]);
    emitLocalConnections();
    return newConn;
  });

  ipcMain.handle(IPC.UPDATE_LOCAL_CONNECTION, (_e, id: string, patch: Partial<LocalConnection>) => {
    const connections = settingsStore.get('localConnections') ?? [];
    const updated = connections.map((c) => (c.id === id ? { ...c, ...patch, id } : c));
    settingsStore.set('localConnections', updated);
    emitLocalConnections();
  });

  ipcMain.handle(IPC.DELETE_LOCAL_CONNECTION, (_e, id: string) => {
    const connections = settingsStore.get('localConnections') ?? [];
    settingsStore.set('localConnections', connections.filter((c) => c.id !== id));
    try { deleteApiKey(`local_${id}`); } catch { /* key may not exist */ }
    emitLocalConnections();
  });

  ipcMain.handle(IPC.TEST_LOCAL_CONNECTION, (_e, url: string, bearerToken?: string) => {
    return ollamaAPI.testConnection(url, bearerToken);
  });

  ipcMain.handle(IPC.SET_LOCAL_CONNECTION_KEY, (_e, id: string, token: string) => {
    setApiKey(`local_${id}`, token);
  });

  ipcMain.handle(IPC.DELETE_LOCAL_CONNECTION_KEY, (_e, id: string) => {
    try { deleteApiKey(`local_${id}`); } catch { /* key may not exist */ }
  });

  // Ollama Model Management
  ipcMain.handle(IPC.GET_OLLAMA_MODELS, (_e, url: string, bearerToken?: string) => {
    return ollamaAPI.getModelDetails(url, bearerToken);
  });

  ipcMain.on(IPC.PULL_OLLAMA_MODEL, (event, url: string, modelTag: string, bearerToken?: string) => {
    const controller = new AbortController();
    ollamaAPI.pullModel(
      url,
      modelTag,
      bearerToken,
      (progress) => { event.sender.send(IPC.OLLAMA_PULL_PROGRESS, progress); },
      controller.signal,
    ).then(() => {
      event.sender.send(IPC.OLLAMA_PULL_COMPLETE, { model: modelTag });
    }).catch((err: Error) => {
      if (err.name !== 'AbortError') {
        event.sender.send(IPC.OLLAMA_PULL_ERROR, { error: err.message });
      }
    });
  });

  ipcMain.handle(IPC.DELETE_OLLAMA_MODEL, (_e, url: string, modelName: string, bearerToken?: string) => {
    return ollamaAPI.deleteModel(url, modelName, bearerToken);
  });

  ipcMain.handle(IPC.CREATE_OLLAMA_MODEL, (_e, url: string, modelTag: string, modelfileJson: string, bearerToken?: string) => {
    return ollamaAPI.createModel(url, modelTag, modelfileJson, bearerToken);
  });

  // Audio capture: relay chunks from overlay renderer to companion
  ipcMain.on(AUDIO_IPC.AUDIO_CHUNK, (_e, buffer: Buffer) => {
    companion.handleAudioChunk(buffer);
  });

  // Track cursor position for overlay rendering
  setInterval(() => {
    const pos = screen.getCursorScreenPoint();
    sendToOverlays(IPC.CURSOR_POSITION, pos);
  }, 16); // ~60fps

  // Poll permissions
  setInterval(async () => {
    const perms = await companion.getPermissions();
    sendToPanel(IPC.PERMISSION_STATUS, perms);
  }, 1500);

  // Open the main window on first launch.
  togglePanel();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Drain any pending chat-history writes before exit.
  chatHistory.flushSync();
});

// macOS: don't quit when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // Don't quit — this is a tray app
});

// ── Window Management ──────────────────────────────────────────────────

function togglePanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isVisible() && panelWindow.isFocused()) {
      panelWindow.hide();
      return;
    }
    panelWindow.show();
    panelWindow.focus();
    return;
  }

  panelWindow = createPanelWindow();
  panelWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Flicky] Panel FAILED to load:', code, desc, url);
  });
  panelWindow.on('close', (e) => {
    // Don't destroy on close — hide so reopening is instant and keeps state.
    if (!isAppQuitting) {
      e.preventDefault();
      panelWindow?.hide();
    }
  });

  panelWindow.show();
  panelWindow.focus();
}

function rebuildOverlays(): void {
  // Destroy existing overlays
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) win.destroy();
  }

  overlayWindows = screen.getAllDisplays().map((display) => createOverlayWindow(display));
  // Respect the persisted "Show cursor" setting — if the user has it
  // turned off, the overlays are created but hidden so we can still
  // route voice-state / element-detected events into their renderers
  // without a visible window on screen.
  applyOverlayVisibility(companion.getSettings().isClickyCursorEnabled);
}

function applyOverlayVisibility(enabled: boolean): void {
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    if (enabled) {
      win.showInactive();
    } else {
      win.hide();
    }
  }
}

/**
 * Show or hide the stream window based on the current visibility
 * setting. 'responses' mode is refined further by updateStreamForVoiceState
 * which flicks it on when Flicky is thinking / speaking.
 */
function applyStreamVisibility(v: StreamVisibility): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  if (v === 'always') {
    streamWindow.showInactive();
  } else if (v === 'off') {
    streamWindow.hide();
  } else {
    // 'responses' — reconcile with whatever Flicky is currently doing
    // so switching *into* this mode immediately reflects the real state
    // (hide if idle, show if mid-turn) instead of waiting for the next
    // voice state transition.
    updateStreamForVoiceState(lastVoiceState);
  }
}

function updateStreamForVoiceState(state: string): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  const v = companion.getSettings().streamVisibility;
  if (v !== 'responses') return;
  const active =
    state === 'listening' ||
    state === 'processing' ||
    state === 'responding' ||
    walkthroughActive;
  if (active) {
    streamWindow.showInactive();
  } else if (state === 'idle') {
    streamWindow.hide();
  }
}

function persistStreamBounds(): void {
  if (!streamWindow || streamWindow.isDestroyed()) return;
  const [x, y] = streamWindow.getPosition();
  const [width, height] = streamWindow.getSize();
  companion.setStreamWindowBounds({ x, y, width, height });
}
