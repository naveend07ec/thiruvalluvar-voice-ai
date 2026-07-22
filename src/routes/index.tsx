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
  idle: "Tap to speak",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Thiruvalluvar is speaking…",
  error: "Something went wrong — tap to try again",
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

function ThiruvalluvarApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [supported, setSupported] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

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
        setStatus("idle");
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
        const { audioBase64, mimeType } = await synth({
          data: { text: reply },
        });
        const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
        audioRef.current = audio;
        audio.onended = () => setStatus("idle");
        audio.onerror = () => setStatus("idle");
        await audio.play();
      } catch (err) {
        console.error(err);
        setErrorMsg(
          err instanceof Error ? err.message : "Unable to reach the sage.",
        );
        setStatus("error");
      }
    },
    [ask, synth],
  );

  const startListening = useCallback(() => {
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
        setErrorMsg("Microphone permission was denied. Please allow mic access.");
        setStatus("error");
      } else if (anyE.error === "no-speech") {
        setStatus("idle");
      } else {
        setStatus("idle");
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      if (finalText.trim()) {
        void handleTranscript(finalText);
      } else if (status === "listening") {
        setStatus("idle");
      }
    };

    recognitionRef.current = rec;
    setStatus("listening");
    try {
      rec.start();
    } catch (err) {
      console.error(err);
      setStatus("idle");
    }
  }, [handleTranscript, status]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const onMicClick = () => {
    if (status === "listening") return stopListening();
    if (status === "thinking" || status === "speaking") return;
    startListening();
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
          Ask a question aloud in Tamil or English. The sage will reply in
          classical Tamil.
        </p>

        {/* Mic */}
        <div className="mt-14 flex flex-col items-center">
          <button
            type="button"
            onClick={onMicClick}
            aria-label="Speak to Thiruvalluvar"
            disabled={!supported || status === "thinking" || status === "speaking"}
            className={`${micClass} disabled:cursor-not-allowed disabled:opacity-70`}
          >
            <MicIcon />
          </button>
          <p className="mt-8 text-lg font-medium text-primary/95">
            {STATUS_LABEL[status]}
          </p>
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
