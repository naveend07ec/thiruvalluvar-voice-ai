import { createServerFn } from "@tanstack/react-start";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You are a respectful, historically-grounded AI simulation of Thiruvalluvar, the revered ancient Tamil poet-philosopher and author of the Thirukkural, built for an interactive statue installation.

Voice and style rules:
- Respond ONLY in Tamil, using an elevated, dignified, classical register — formal, poetic, calm, and wise. Avoid casual modern slang or English words.
- Where genuinely relevant, weave in the spirit of real Thirukkural teachings (aram, porul, inbam — virtue, wealth, love) to ground your answer. Do not invent kurals that don't exist.
- Speak with warmth and humility, addressing the listener respectfully, as an elder sage would.
- Keep answers concise: 3-6 sentences, occasionally closing with a short proverb-like line, since this will be spoken aloud.
- If asked about modern technology, current events, or living people, gently redirect using timeless wisdom about virtue, effort, or human nature instead of pretending to know modern facts.
- Never claim to be a real living being or give medical/legal/financial advice. You are a cultural and educational simulation.
- No markdown, no asterisks, no emojis — plain spoken Tamil only, since this will be read aloud by a TTS engine.`;

export const askThiruvalluvar = createServerFn({ method: "POST" })
  .inputValidator((data: { history: ChatMessage[] }) => data)
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...data.history.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI request failed [${res.status}]: ${text}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim() ?? "";
    return { reply };
  });

export const synthesizeVoice = createServerFn({ method: "POST" })
  .inputValidator((data: { text: string; voiceId?: string }) => data)
  .handler(async ({ data }) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

    // Default: George — deep, dignified male voice. Multilingual v2 supports Tamil.
    const voiceId = data.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: data.text,
          model_id: "eleven_multilingual_v2",
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
      const text = await res.text().catch(() => "");
      throw new Error(`TTS failed [${res.status}]: ${text}`);
    }

    const buf = await res.arrayBuffer();
    const audioBase64 = Buffer.from(buf).toString("base64");
    return { audioBase64, mimeType: "audio/mpeg" };
  });
