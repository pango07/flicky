import { useState, useEffect, useRef, useCallback } from 'react';
import type { VoiceState, WalkthroughStep, TypeRequest } from '../../shared/types';
import { Waveform } from './Waveform';

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
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** true while getUserMedia hasn't resolved yet. */
  const micStartingRef = useRef(false);
  /** set by stopMic so a pending start can abort before attaching. */
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
    const startMic = async () => {
      // Ignore overlapping starts.
      if (micStartingRef.current || mediaStreamRef.current) return;
      micStartingRef.current = true;
      micStopRequestedRef.current = false;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        });

        // A stop may have arrived before getUserMedia resolved; if so,
        // release the stream immediately instead of attaching it.
        if (micStopRequestedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        mediaStreamRef.current = stream;

        const ctx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);

        const processor = ctx.createScriptProcessor(4096, 1, 1);
        scriptNodeRef.current = processor;

        processor.onaudioprocess = (e) => {
          const float32 = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          window.flicky.sendAudioChunk(pcm16.buffer);
        };

        source.connect(processor);
        processor.connect(ctx.destination);
      } catch (err) {
        console.error('[Flicky] Mic capture failed:', err);
      } finally {
        micStartingRef.current = false;
      }
    };

    const stopMic = () => {
      // Flag for any in-flight startMic to bail before it attaches.
      micStopRequestedRef.current = true;
      scriptNodeRef.current?.disconnect();
      scriptNodeRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
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
      stopMic();
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
    const unsubDisplayInfo = window.flicky.onDisplayInfo((info) => {
      displayRef.current = { id: info.id, bounds: info.bounds };
    });

    const unsubs = [
      window.flicky.onVoiceStateChanged(setVoiceState),
      window.flicky.onCursorPosition((pos) => {
        const bounds = displayRef.current?.bounds;
        if (bounds) {
          const onThis =
            pos.x >= bounds.x && pos.x < bounds.x + bounds.width &&
            pos.y >= bounds.y && pos.y < bounds.y + bounds.height;
          setIsCursorOnThisDisplay(onThis);
          setCursorPos({ x: pos.x - bounds.x, y: pos.y - bounds.y });
        } else {
          setIsCursorOnThisDisplay(true);
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
  const showOnThisDisplay = isCursorOnThisDisplay || isNavigating || isHolding;

  const cursorTransition = isNavigating
    ? 'left 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
    : cursorMode === 'following'
      ? 'left 0.05s linear, top 0.05s linear'
      : 'none';

  const showAnnotation = (isNavigating || isHolding) && currentStep !== null;
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
            <span className="type-toast-icon" aria-hidden>📋</span>
            <div className="type-toast-text">
              <div className="type-toast-title">
                Copied — press{' '}
                <kbd>{process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}</kbd> to paste
              </div>
              <div className="type-toast-preview">&ldquo;{typeToast.preview}&rdquo;</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
