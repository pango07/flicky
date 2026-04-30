import { useState, useEffect, useRef, useCallback } from 'react';
import type { VoiceState, WalkthroughStep, TypeRequest } from '../../shared/types';
import { Waveform } from './Waveform';

// Vite resolves `new URL(..., import.meta.url)` at build time and emits
// the worklet as a static asset. The `.js` file is hand-written plain
// JS (worklets must be), so it isn't part of the TS compilation unit;
// we only need its URL to feed `audioWorklet.addModule()`.
const captureWorkletUrl = new URL('../audio-capture-worklet.js', import.meta.url).href;

// Offset the companion cursor ~1/5 inch (≈19px at 96dpi) down-right
// of the real mouse so the tip doesn't sit directly on top of it.
const FOLLOW_OFFSET_X = 14;
const FOLLOW_OFFSET_Y = 8;

const POINTING_PHRASES = [
  'right here!',
  'found it!',
  'this one!',
  'over here!',
  'look!',
  'here it is!',
  'this thing!',
  'see this?',
];

function randomPhrase(): string {
  return POINTING_PHRASES[Math.floor(Math.random() * POINTING_PHRASES.length)];
}

type CursorMode = 'following' | 'navigating' | 'holding' | 'returning';

export function OverlayApp() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [currentStep, setCurrentStep] = useState<WalkthroughStep | null>(null);
  const [pointingPhrase, setPointingPhrase] = useState('');
  const [cursorMode, setCursorMode] = useState<CursorMode>('following');
  const [companionPos, setCompanionPos] = useState({ x: 0, y: 0 });
  const [isCursorOnThisDisplay, setIsCursorOnThisDisplay] = useState(false);
  const [typeToast, setTypeToast] = useState<TypeRequest | null>(null);
  const typeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayRef = useRef<{ id: number; bounds: { x: number; y: number; width: number; height: number } } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepsRef = useRef<WalkthroughStep[]>([]);
  const returnAnimRef = useRef<number | null>(null);
  const cursorPosRef = useRef({ x: 0, y: 0 });
  const companionPosRef = useRef({ x: 0, y: 0 });

  // ── Mic capture ──────────────────────────────────────────────────────
  // The audio graph (stream → AudioContext → AudioWorkletNode → destination)
  // is built once on first PTT and kept warm across turns. Start/stop just
  // toggles a flag inside the worklet so we don't pay getUserMedia or
  // worklet-module-load latency on every press.
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** true while getUserMedia / addModule are in flight. */
  const micStartingRef = useRef(false);
  /** set by stopMic so a pending start can bail before attaching. */
  const micStopRequestedRef = useRef(false);

  // ── TTS playback (cancelable) ───────────────────────────────────────
  const ttsRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const stopCurrentTts = useCallback(() => {
    const current = ttsRef.current;
    if (!current) return;
    try {
      current.audio.pause();
      current.audio.src = '';
    } catch { /* ignore */ }
    URL.revokeObjectURL(current.url);
    ttsRef.current = null;
  }, []);

  useEffect(() => {
    const ensureGraph = async (): Promise<AudioWorkletNode | null> => {
      if (workletNodeRef.current) return workletNodeRef.current;
      if (micStartingRef.current) return null;
      micStartingRef.current = true;
      micStopRequestedRef.current = false;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        });
        // If a stop arrived while we were waiting on getUserMedia, the
        // user has already released the key. Don't bother building the
        // graph; the next press will re-enter and rebuild.
        if (micStopRequestedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        const ctx = new AudioContext({ sampleRate: 16000 });
        await ctx.audioWorklet.addModule(captureWorkletUrl);
        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, 'capture-processor');
        node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          window.flicky.sendAudioChunk(e.data);
        };
        // Pull-graph: source → worklet → destination. The worklet
        // leaves its outputs zeroed when 'enabled', so connecting to
        // destination is silent — we only need it so the audio engine
        // schedules `process()`.
        source.connect(node);
        node.connect(ctx.destination);
        mediaStreamRef.current = stream;
        audioCtxRef.current = ctx;
        workletNodeRef.current = node;
        return node;
      } catch (err) {
        console.error('[Flicky] Mic capture init failed:', err);
        return null;
      } finally {
        micStartingRef.current = false;
      }
    };

    const startMic = async () => {
      // Reset the stop flag at the top so subsequent presses always
      // get a fresh start signal. On the very first press, ensureGraph
      // also resets this; on press 2+, ensureGraph short-circuits with
      // the existing node and would never clear the flag — leaving it
      // stuck `true` and silently bailing every subsequent call.
      micStopRequestedRef.current = false;
      const node = await ensureGraph();
      // If a stop landed between ensureGraph resolving and now, don't
      // open the gate — the worklet stays muted.
      if (!node || micStopRequestedRef.current) return;
      node.port.postMessage('start');
    };

    const stopMic = () => {
      // Flag for any in-flight ensureGraph to bail before opening the
      // gate. If the graph already exists, just mute the worklet —
      // tearing down would force a fresh getUserMedia next turn.
      micStopRequestedRef.current = true;
      workletNodeRef.current?.port.postMessage('stop');
    };

    const unsubStart = window.flicky.onStartCapture(() => startMic());
    const unsubStop = window.flicky.onStopCapture(() => stopMic());

    // Play TTS audio. Any previous playback is interrupted first so
    // back-to-back responses don't stack on top of each other.
    const unsubPlayAudio = window.flicky.onPlayAudio(async (audioData) => {
      stopCurrentTts();
      try {
        const blob = new Blob([audioData], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsRef.current = { audio, url };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (ttsRef.current?.audio === audio) ttsRef.current = null;
        };
        await audio.play();
      } catch (err) {
        console.error('[Flicky] Audio playback failed:', err);
        stopCurrentTts();
      }
    });

    return () => {
      unsubStart();
      unsubStop();
      unsubPlayAudio();
      // Real teardown on unmount — stopMic only mutes the worklet so
      // back-to-back PTT turns stay warm. When the overlay actually
      // goes away (display unplug, app quit) we release the mic and
      // close the AudioContext.
      micStopRequestedRef.current = true;
      workletNodeRef.current?.port.postMessage('stop');
      workletNodeRef.current?.disconnect();
      workletNodeRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

  const setCursorModeSync = useCallback((mode: CursorMode) => {
    setCursorMode(mode);
  }, []);

  const setCompanionPosSync = useCallback((pos: { x: number; y: number }) => {
    companionPosRef.current = pos;
    setCompanionPos(pos);
  }, []);

  const startReturnAnimation = useCallback(() => {
    setCursorModeSync('returning');

    const animate = () => {
      const raw = cursorPosRef.current;
      const target = { x: raw.x + FOLLOW_OFFSET_X, y: raw.y + FOLLOW_OFFSET_Y };
      const current = companionPosRef.current;
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 2) {
        setCompanionPosSync(target);
        setCursorModeSync('following');
        returnAnimRef.current = null;
        return;
      }

      const next = { x: current.x + dx * 0.08, y: current.y + dy * 0.08 };
      setCompanionPosSync(next);
      returnAnimRef.current = requestAnimationFrame(animate);
    };

    returnAnimRef.current = requestAnimationFrame(animate);
  }, [setCursorModeSync, setCompanionPosSync]);

  useEffect(() => {
    if (cursorMode === 'following') {
      setCompanionPosSync({
        x: cursorPos.x + FOLLOW_OFFSET_X,
        y: cursorPos.y + FOLLOW_OFFSET_Y,
      });
    }
    cursorPosRef.current = cursorPos;
  }, [cursorPos, cursorMode, setCompanionPosSync]);

  useEffect(() => {
    // Pull display info eagerly. The push from main is also wired (below),
    // but if we mount after that one-shot fires, we'd never learn our
    // bounds and would render the cursor on every display.
    window.flicky.getDisplayInfo().then((info) => {
      if (info && !displayRef.current) {
        displayRef.current = { id: info.id, bounds: info.bounds };
      }
    });

    const unsubDisplayInfo = window.flicky.onDisplayInfo((info) => {
      displayRef.current = { id: info.id, bounds: info.bounds };
    });

    const unsubs = [
      window.flicky.onVoiceStateChanged(setVoiceState),
      window.flicky.onCursorPosition((pos) => {
        // Main now sends a `{ off: true }` pulse to whichever overlay
        // previously owned the cursor when it leaves that display.
        // We stop receiving regular updates entirely once the cursor
        // is off-display, which is why this signal is needed at all.
        if ((pos as { off?: boolean }).off) {
          setIsCursorOnThisDisplay(false);
          return;
        }
        const bounds = displayRef.current?.bounds;
        if (bounds) {
          const onThis =
            pos.x >= bounds.x && pos.x < bounds.x + bounds.width &&
            pos.y >= bounds.y && pos.y < bounds.y + bounds.height;
          setIsCursorOnThisDisplay(onThis);
          setCursorPos({ x: pos.x - bounds.x, y: pos.y - bounds.y });
        } else {
          // Bounds unknown — hide the companion rather than risk
          // showing it on every display. Will flip on as soon as
          // display-info arrives.
          setIsCursorOnThisDisplay(false);
          setCursorPos(pos);
        }
      }),
      window.flicky.onWalkthrough((w) => {
        // Cache the steps. Main drives advancement via WALKTHROUGH_STEP.
        if (returnAnimRef.current) {
          cancelAnimationFrame(returnAnimRef.current);
          returnAnimRef.current = null;
        }
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        if (!w) {
          stepsRef.current = [];
          setCurrentStep(null);
          holdTimerRef.current = setTimeout(() => {
            holdTimerRef.current = null;
            startReturnAnimation();
          }, 1500);
          return;
        }
        stepsRef.current = w.steps;
      }),
      window.flicky.onTypeFulfilled((req) => {
        if (typeToastTimerRef.current) clearTimeout(typeToastTimerRef.current);
        setTypeToast(req);
        typeToastTimerRef.current = setTimeout(() => {
          setTypeToast(null);
          typeToastTimerRef.current = null;
        }, 5000);
      }),
      window.flicky.onWalkthroughStep((i) => {
        if (i === null) {
          // Walkthrough ending — the WALKTHROUGH(null) event will
          // schedule the return animation. Just clear current step UI.
          setCurrentStep(null);
          return;
        }
        const step = stepsRef.current[i];
        if (!step) return;
        setPointingPhrase(randomPhrase());
        setCurrentStep(step);
        const bounds = displayRef.current?.bounds;
        setCompanionPosSync({
          x: step.x - (bounds?.x ?? 0),
          y: step.y - (bounds?.y ?? 0),
        });
        setCursorModeSync('navigating');
        setTimeout(() => setCursorModeSync('holding'), 650);
      }),
    ];

    return () => {
      unsubDisplayInfo();
      unsubs.forEach((u) => u());
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (typeToastTimerRef.current) clearTimeout(typeToastTimerRef.current);
      if (returnAnimRef.current) cancelAnimationFrame(returnAnimRef.current);
    };
  }, [setCursorModeSync, setCompanionPosSync, startReturnAnimation]);

  useEffect(() => {
    if (voiceState === 'listening') {
      // User started a new turn — interrupt anything Flicky was saying.
      stopCurrentTts();
      setCurrentStep(null);
      stepsRef.current = [];
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (returnAnimRef.current) {
        cancelAnimationFrame(returnAnimRef.current);
        returnAnimRef.current = null;
      }
      setCursorModeSync('following');
    }
  }, [voiceState, setCursorModeSync, stopCurrentTts]);

  const isNavigating = cursorMode === 'navigating';
  const isHolding = cursorMode === 'holding';

  // Walkthrough steps are always *on* one specific display (the one the
  // cursor was on when the screenshot was taken). Render the annotated
  // cursor only on that display so users with multiple monitors don't
  // see the blue cursor flying around on a screen the step isn't on.
  const isStepOnThisDisplay = (() => {
    if (!currentStep) return false;
    const b = displayRef.current?.bounds;
    if (!b) return false;
    return (
      currentStep.x >= b.x && currentStep.x < b.x + b.width &&
      currentStep.y >= b.y && currentStep.y < b.y + b.height
    );
  })();

  const showOnThisDisplay =
    isNavigating || isHolding ? isStepOnThisDisplay : isCursorOnThisDisplay;

  const cursorTransition = isNavigating
    ? 'left 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
    : cursorMode === 'following'
      ? 'left 0.05s linear, top 0.05s linear'
      : 'none';

  const showAnnotation = (isNavigating || isHolding) && isStepOnThisDisplay;
  const isMultiStep = (currentStep?.total ?? 0) > 1;

  return (
    <div className="overlay-container">
      {showOnThisDisplay && (
        <>
          {showAnnotation && (
            <div
              className="target-halo"
              style={{ left: companionPos.x, top: companionPos.y }}
            />
          )}

          <div
            className={`cursor-triangle ${isNavigating || isHolding ? 'navigating' : ''}`}
            style={{
              left: companionPos.x,
              top: companionPos.y,
              transition: cursorTransition,
            }}
          >
            <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="fl-front" x1="10%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#e0f2fe" />
                  <stop offset="50%" stopColor="#7dd3fc" />
                  <stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
              </defs>

              {/* Single glossy triangle — tip at upper-left, body trails down-right */}
              <polygon
                points="4,4 34,14 14,32"
                fill="url(#fl-front)"
                stroke="url(#fl-front)"
                strokeWidth="3"
                strokeLinejoin="round"
              />

              {/* Upper edge gloss highlight */}
              <polyline
                points="4,4 34,14"
                fill="none"
                stroke="rgba(255,255,255,0.65)"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <polyline
                points="4,4 14,32"
                fill="none"
                stroke="rgba(255,255,255,0.4)"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </div>

          {voiceState === 'listening' && (
            <div
              className="overlay-waveform"
              style={{ left: companionPos.x + 44, top: companionPos.y + 2 }}
            >
              <Waveform state="listening" bars={10} height={22} />
            </div>
          )}

          {voiceState === 'processing' && (
            <div
              className="processing-spinner"
              style={{ left: companionPos.x + 44, top: companionPos.y + 6 }}
            />
          )}

          {showAnnotation && (
            <div
              className="pointing-bubble"
              style={{
                left: companionPos.x + 44,
                top: companionPos.y - 8,
              }}
            >
              {isMultiStep && (
                <span className="step-badge">
                  {currentStep!.step}
                  <span className="step-badge-total">/{currentStep!.total}</span>
                </span>
              )}
              <span className="bubble-text">
                {isMultiStep ? currentStep!.label : pointingPhrase}
              </span>
            </div>
          )}
        </>
      )}

      {typeToast && isCursorOnThisDisplay && (
        <div className="type-toast" role="status">
          <div className="type-toast-row">
            <span className="type-toast-icon" aria-hidden>
              {typeToast.autoTyped ? '⌨️' : '📋'}
            </span>
            <div className="type-toast-text">
              <div className="type-toast-title">
                {typeToast.autoTyped ? (
                  'Typed for you'
                ) : (
                  <>
                    Copied — press{' '}
                    <kbd>{window.flicky.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}</kbd> to paste
                  </>
                )}
              </div>
              <div className="type-toast-preview">&ldquo;{typeToast.preview}&rdquo;</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
