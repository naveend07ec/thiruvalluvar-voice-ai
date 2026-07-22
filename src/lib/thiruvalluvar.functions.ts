import { createServerFn } from "@tanstack/react-start";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are a respectful, historically-grounded AI simulation of Thiruvalluvar, the revered ancient Tamil poet-philosopher and author of the Thirukkural, built for an interactive statue installation.

Voice and style rules:
- Respond ONLY in Tamil, using an elevated, dignified, classical register — formal, poetic, calm, and wise. Avoid casual modern slang or English words.
- Where genuinely relevant, weave in the spirit of real Thirukkural teachings (aram, porul, inbam — virtue, wealth, love) to ground your answer. Do not invent kurals that don't exist.
- Speak with warmth and humility, addressing the listener respectfully, as an elder sage would.
- Keep answers SHORT: 2-4 sentences maximum, since this will be spoken aloud and shorter replies are faster to generate and speak.
- If asked about modern technology, current events, or living people, gently redirect using timeless wisdom about virtue, effort, or human nature instead of pretending to know modern facts.
- Never claim to be a real living being or give medical/legal/financial advice. You are a cultural and educational simulation.
- No markdown, no asterisks, no emojis — plain spoken Tamil only, since this will be read aloud by a TTS engine.`;

export const askThiruvalluvar = createServerFn({ method: "POST" })
  .inputValidator((data: { history: ChatMessage[] }) => data)
  .handler(async ({ data }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    // Only send the last 6 turns — keeps token count (and cost/latency) low
    // without hurting answer quality for this persona.
    const trimmedHistory = data.history.slice(-6);

    const contents = trimmedHistory.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: {
            maxOutputTokens: 200, // hard cap — keeps replies short and fast
          },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI request failed [${res.status}]: ${text}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const reply = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    return { reply };
  });

// Splits a reply into speakable sentence chunks (Tamil and English punctuation).
function splitIntoSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

async function synthesizeOne(text: string, apiKey: string, voiceId: string) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5", // faster model than multilingual_v2
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.8,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS failed [${res.status}]: ${errText}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

// Returns an array of audio clips, one per sentence, in order.
// The frontend can start playing clip[0] as soon as it arrives instead
// of waiting for the entire reply to be synthesized as one file.
export const synthesizeVoice = createServerFn({ method: "POST" })
  .inputValidator((data: { text: string; voiceId?: string }) => data)
  .handler(async ({ data }) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

    // Default: George — deep, dignified male voice. Multilingual/Flash v2.5 supports Tamil.
    const voiceId = data.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";

    const sentences = splitIntoSentences(data.text);

    // Synthesize all sentences in parallel — total wait time is roughly
    // the time for the SLOWEST sentence, not the sum of all of them.
    const clips = await Promise.all(
      sentences.map((s) => synthesizeOne(s, apiKey, voiceId)),
    );

    return {
      clips: clips.map((audioBase64) => ({ audioBase64, mimeType: "audio/mpeg" })),
    };
  });
