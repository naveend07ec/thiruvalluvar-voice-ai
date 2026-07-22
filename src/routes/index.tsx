import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  askThiruvalluvar,
  synthesizeVoice,
} from "@/lib/thiruvalluvar.functions";

export const Route = createFileRoute("/")({
  component: ThiruvalluvarApp,
});

type ChatMessage = { role: "user" | "assistant"; content: string };
type Status = "idle" | "listening" | "thinking" | "speaking" | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Press Start to begin",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Thiruvalluvar is speaking…",
  error: "Something went wrong",
};

// Web Speech API type shim — kept local so the STT layer can be swapped later
// (Whisper / Deepgram / Google) without touching component logic.
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-16 w-16"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-14 w-14">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

// Plays a list of { audioBase64, mimeType } clips back-to-back, starting
// clip 0 immediately. Resolves once every clip has finished playing, or
// once stopped early via audioRef being paused/cleared externally.
function playClipsSequentially(
  clips: Array<{ audioBase64: string; mimeType: string }>,
  audioRef: React.MutableRefObject<HTMLAudioElement | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (clips.length === 0) {
      resolve();
      return;
    }
    const audio = new Audio();
    audioRef.current = audio;
    let i = 0;
    let stopped = false;

    const playNext = () => {
      if (stopped) {
        resolve();
        return;
      }
      if (i >= clips.length) {
        resolve();
        return;
      }
      const clip = clips[i++];
      audio.src = `data:${clip.mimeType};base64,${clip.audioBase64}`;
      audio.play().catch(reject);
    };

    audio.onended = playNext;
    audio.onerror = () => reject(new Error("Audio playback failed"));
    // If something external pauses/clears this audio element (Stop button),
    // treat that as "done" rather than letting it hang forever.
    audio.onpause = () => {
      if (audio.currentTime === 0 || audio.ended) return;
      stopped = true;
      resolve();
    };
    playNext();
  });
}

function ThiruvalluvarApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [conversationActive, setConversationActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [supported, setSupported] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Mirrors conversationActive but readable synchronously inside callbacks
  // (React state updates are async, so a plain ref avoids stale-closure bugs
  // in the recognition event handlers below).
  const conversationActiveRef = useRef(false);
  // Holds the latest startListening function so handleTranscript can call it
  // after speaking finishes, without a circular useCallback dependency.
  const startListeningRef = useRef<() => void>(() => {});

  const ask = useServerFn(askThiruvalluvar);
  const synth = useServerFn(synthesizeVoice);

  useEffect(() => {
    setSupported(!!getSpeechRecognition());
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleTranscript = useCallback(
    async (userText: string) => {
      const cleaned = userText.trim();
      if (!cleaned) {
        // Nothing was said — if the conversation is still active, just
        // listen again instead of dropping back to idle.
        if (conversationActiveRef.current) {
          startListeningRef.current();
        } else {
          setStatus("idle");
        }
        return;
      }
      const nextHistory: ChatMessage[] = [
        ...messagesRef.current,
        { role: "user", content: cleaned },
      ];
      setMessages(nextHistory);
      setStatus("thinking");
      try {
        const { reply } = await ask({ data: { history: nextHistory } });
        const assistantMsg: ChatMessage = { role: "assistant", content: reply };
        setMessages((prev) => [...prev, assistantMsg]);

        setStatus("speaking");
        const { clips } = await synth({ data: { text: reply } });
        await playClipsSequentially(clips, audioRef);

        // Only continue the loop if the user hasn't pressed Stop while
        // we were thinking/speaking.
        if (conversationActiveRef.current) {
          startListeningRef.current();
        } else {
          setStatus("idle");
        }
      } catch (err) {
        console.error(err);
        setErrorMsg(
          err instanceof Error ? err.message : "Unable to reach the sage.",
        );
        setStatus("error");
        // A real error ends the conversation loop rather than retrying
        // forever against a broken backend.
        conversationActiveRef.current = false;
        setConversationActive(false);
      }
    },
    [ask, synth],
  );

  const startListening = useCallback(() => {
    if (!conversationActiveRef.current) return; // Stop was pressed meanwhile
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setErrorMsg(null);
    const rec = new Ctor();
    rec.lang = "ta-IN";
    rec.interimResults = false;
    rec.continuous = false;

    let finalText = "";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
    };
    rec.onerror = (e: Event) => {
      const anyE = e as unknown as { error?: string };
      console.error("Speech recognition error:", anyE.error);
      if (anyE.error === "not-allowed") {
        // Permission problems can't be fixed by retrying — stop the loop.
        setErrorMsg("Microphone permission was denied. Please allow mic access.");
        setStatus("error");
        conversationActiveRef.current = false;
        setConversationActive(false);
        return;
      }
      // "no-speech" or any transient error: if still in conversation mode,
      // just try listening again instead of dropping to idle.
      if (conversationActiveRef.current) {
        startListeningRef.current();
      } else {
        setStatus("idle");
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      if (finalText.trim()) {
        void handleTranscript(finalText);
      } else if (conversationActiveRef.current) {
        // Silence timeout with nothing said — keep listening.
        startListeningRef.current();
      } else {
        setStatus("idle");
      }
    };

    recognitionRef.current = rec;
    setStatus("listening");
    try {
      rec.start();
    } catch (err) {
      console.error(err);
      if (conversationActiveRef.current) {
        // rec.start() can throw if called too quickly after a previous
        // instance stopped — a short retry handles that race safely.
        setTimeout(() => startListeningRef.current(), 300);
      } else {
        setStatus("idle");
      }
    }
  }, [handleTranscript]);

  // Keep the ref pointed at the latest startListening closure.
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const startConversation = useCallback(() => {
    conversationActiveRef.current = true;
    setConversationActive(true);
    setErrorMsg(null);
    startListeningRef.current();
  }, []);

  const stopConversation = useCallback(() => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    recognitionRef.current?.stop();
    recognitionRef.current?.abort();
    audioRef.current?.pause();
    setStatus("idle");
  }, []);

  const onMainButtonClick = () => {
    if (conversationActive) {
      stopConversation();
    } else {
      startConversation();
    }
  };

  const micClass =
    status === "listening" ? "btn-mic btn-mic-active" : "btn-mic btn-mic-idle";

  return (
    <div className="relative min-h-screen">
      {/* Top badge */}
      <div className="flex justify-center pt-6">
        <span className="rounded-full border border-accent/50 bg-card/60 px-4 py-1.5 text-xs uppercase tracking-widest text-primary/90 backdrop-blur">
          MVP Voice Demo · Character: Thiruvalluvar
        </span>
      </div>

      <main className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-10 pb-24">
        <h1 className="bg-clip-text text-center font-display text-5xl font-semibold tracking-tight text-transparent sm:text-6xl"
            style={{ backgroundImage: "var(--gradient-gold)" }}>
          Thiruvalluvar AI
        </h1>
        <p className="mt-3 max-w-md text-center text-sm text-muted-foreground">
          {conversationActive
            ? "Conversation is live — just keep speaking after each answer. Press Stop when you're done."
            : "Press Start, then ask a question aloud in Tamil or English. The sage will keep listening after each answer until you press Stop."}
        </p>

        {/* Mic / Start-Stop */}
        <div className="mt-14 flex flex-col items-center">
          <button
            type="button"
            onClick={onMainButtonClick}
            aria-label={conversationActive ? "Stop conversation" : "Start conversation"}
            disabled={!supported}
            className={`${micClass} disabled:cursor-not-allowed disabled:opacity-70`}
          >
            {conversationActive ? <StopIcon /> : <MicIcon />}
          </button>
          <p className="mt-8 text-lg font-medium text-primary/95">
            {conversationActive ? STATUS_LABEL[status] : "Press Start to begin"}
          </p>
          {conversationActive && (
            <p className="mt-1 text-xs uppercase tracking-widest text-accent/80">
              Conversation active — tap the button to stop
            </p>
          )}
          {!supported && (
            <p className="mt-2 max-w-sm text-center text-sm text-destructive-foreground/90">
              Your browser doesn't support speech recognition. Please use Chrome
              or Edge on desktop for the demo.
            </p>
          )}
          {errorMsg && status === "error" && (
            <p className="mt-2 max-w-sm text-center text-sm text-amber-200/90">
              {errorMsg}
            </p>
          )}
        </div>

        {/* Transcript */}
        <section className="mt-16 w-full">
          <h2 className="mb-3 text-center text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Conversation
          </h2>
          <div className="max-h-[42vh] overflow-y-auto rounded-2xl border border-border/60 bg-card/40 p-5 shadow-inner backdrop-blur">
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm italic text-muted-foreground">
                The stone listens. Speak, and it shall answer.
              </p>
            ) : (
              <ul className="space-y-4">
                {messages.map((m, i) => (
                  <li key={i} className="flex flex-col gap-1">
                    <span
                      className={`text-xs uppercase tracking-widest ${
                        m.role === "user" ? "text-accent" : "text-primary"
                      }`}
                    >
                      {m.role === "user" ? "You" : "Thiruvalluvar"}
                    </span>
                    <p
                      className={`whitespace-pre-wrap leading-relaxed ${
                        m.role === "assistant"
                          ? "font-tamil text-lg text-foreground"
                          : "text-base text-foreground/90"
                      }`}
                    >
                      {m.content}
                    </p>
                  </li>
                ))}
                <div ref={transcriptEndRef} />
              </ul>
            )}
          </div>
        </section>
      </main>

      <footer className="pointer-events-none fixed bottom-4 left-0 right-0 text-center text-xs text-muted-foreground/70">
        Prototype for client presentation — hardware integration (statue
        mic/speaker) planned for next phase.
      </footer>
    </div>
  );
}
