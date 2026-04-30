import { useEffect, useRef, useState } from 'react';
import type {
  ChatEntry,
  TranscriptionResult,
  VoiceState,
  Walkthrough,
} from '../../shared/types';

interface Turn {
  id: string;
  user: string;
  ai: string;
  /** Whether the AI portion is still being streamed in. */
  streaming: boolean;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The transparent floating window that mirrors the live Q/A stream.
 * It subscribes to the same IPC feed the panel uses (transcript updates,
 * response chunks, completed entries) and renders them in a scrollable
 * list. The window chrome itself (size / position / drag) is handled by
 * the main process; this component only draws what's inside.
 */
export function StreamApp() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Tracks the in-progress turn so chunks can append to it. */
  const currentIdRef = useRef<string | null>(null);

  // Load existing history once so the stream window isn't empty on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await window.flicky.getChatHistory();
        if (cancelled) return;
        setTurns(
          history.map((h: ChatEntry) => ({
            id: h.id,
            user: h.userText,
            ai: h.assistantText,
            streaming: false,
          })),
        );
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubState = window.flicky.onVoiceStateChanged(setVoiceState);

    const unsubTranscript = window.flicky.onTranscriptUpdate((result: TranscriptionResult) => {
      // A final transcript marks the start of a new turn — seed it with
      // the user text and an empty AI body the chunks will append to.
      if (!result.isFinal) return;
      const id = makeId();
      currentIdRef.current = id;
      setTurns((prev) => [
        ...prev,
        { id, user: result.text, ai: '', streaming: true },
      ]);
    });

    const unsubChunk = window.flicky.onAiResponseChunk((chunk: string) => {
      const id = currentIdRef.current;
      if (!id) return;
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ai: t.ai + chunk } : t)),
      );
    });

    const unsubComplete = window.flicky.onAiResponseComplete((fullText: string) => {
      const id = currentIdRef.current;
      if (!id) return;
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, ai: fullText, streaming: false } : t,
        ),
      );
      currentIdRef.current = null;
    });

    const unsubWalkthrough = window.flicky.onWalkthrough((w) => {
      setWalkthrough(w);
      if (!w) setActiveStep(null);
    });

    const unsubWalkthroughStep = window.flicky.onWalkthroughStep((i) => {
      setActiveStep(i);
    });

    return () => {
      unsubState();
      unsubTranscript();
      unsubChunk();
      unsubComplete();
      unsubWalkthrough();
      unsubWalkthroughStep();
    };
  }, []);

  // Auto-scroll to bottom while content grows — but only if the user
  // is already pinned at the bottom. If they've scrolled up to read an
  // earlier turn, we leave their viewport alone instead of yanking them
  // back. The scroll write itself is deferred to rAF so a long token
  // stream doesn't force synchronous layout on every chunk.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const PIN_THRESHOLD_PX = 24;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > PIN_THRESHOLD_PX) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [turns]);

  const statusLabel =
    voiceState === 'listening'
      ? 'listening…'
      : voiceState === 'processing'
        ? 'thinking…'
        : voiceState === 'responding'
          ? 'responding'
          : 'idle';

  return (
    <div className="stream-root">
      <div className="stream-head">
        <span className="title">Flicky · {statusLabel}</span>
        <button
          className="btn"
          title="Clear the on-screen stream (chat history is untouched)"
          onClick={() => {
            setTurns([]);
            currentIdRef.current = null;
          }}
        >
          clear
        </button>
      </div>
      <div className="stream-body" ref={bodyRef}>
        {walkthrough && walkthrough.steps.length > 0 && (
          <div className="walkthrough-card">
            <div className="walkthrough-head">
              <span className="walkthrough-title">Walkthrough</span>
              <span className="walkthrough-progress">
                {activeStep === null
                  ? `${walkthrough.steps.length} step${walkthrough.steps.length === 1 ? '' : 's'}`
                  : `step ${activeStep + 1} of ${walkthrough.steps.length}`}
              </span>
            </div>
            <ol className="walkthrough-steps">
              {walkthrough.steps.map((s, i) => {
                const state =
                  activeStep === null
                    ? 'pending'
                    : i < activeStep
                      ? 'done'
                      : i === activeStep
                        ? 'active'
                        : 'pending';
                return (
                  <li key={i} className={`walkthrough-step ${state}`}>
                    <span className="walkthrough-num">
                      {state === 'done' ? '✓' : i + 1}
                    </span>
                    <span className="walkthrough-label">{s.label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {turns.length === 0 && !walkthrough ? (
          <div className="stream-empty">
            Hold the push-to-talk shortcut and start talking. The live Q/A will appear here.
          </div>
        ) : turns.length === 0 ? null : (
          turns.map((t) => (
            <div key={t.id} className="stream-turn">
              <div className="stream-label">You</div>
              <div className="stream-user">{t.user}</div>
              <div className="stream-label" style={{ marginTop: 6 }}>
                Flicky
              </div>
              <div className="stream-ai">
                {t.ai}
                {t.streaming && <span className="stream-caret" />}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
