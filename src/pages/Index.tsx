import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Orb from "@/components/Orb";
import MicButton from "@/components/MicButton";
import SettingsPanel from "@/components/SettingsPanel";
import TopBar from "@/components/TopBar";
import { defaultSettings, orbPaletteHues, type ZaraSettings } from "@/lib/settings";
import { sendVoiceChunk, syncBackendMode, type BackendEmotion } from "@/lib/backend";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const AUTO_STOP_MS = 4500;

function chooseRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }

  const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return preferred.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function truncate(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function pickPreferredFemaleVoice(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | null {
  if (!voices.length) {
    return null;
  }

  const normalizedLanguage = language.toLowerCase();
  const langPrefix = normalizedLanguage.split("-")[0];

  const byLanguage = voices.filter((voice) => {
    const voiceLang = voice.lang.toLowerCase();
    return voiceLang === normalizedLanguage || voiceLang.startsWith(`${langPrefix}-`) || voiceLang.startsWith(langPrefix);
  });

  const pool = byLanguage.length ? byLanguage : voices;

  const femaleMarkers = [
    "female",
    "woman",
    "girl",
    "zira",
    "samantha",
    "victoria",
    "joanna",
    "ava",
    "aria",
    "jenny",
    "sara",
    "sonia",
  ];

  const female = pool.find((voice) => {
    const name = voice.name.toLowerCase();
    return femaleMarkers.some((marker) => name.includes(marker));
  });

  return female ?? pool[0] ?? null;
}

const Index = () => {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ZaraSettings>(defaultSettings);
  const [assistantText, setAssistantText] = useState("Hello, I'm ZARA.");
  const [lastTranscript, setLastTranscript] = useState("");
  const [lastEmotion, setLastEmotion] = useState<BackendEmotion>("neutral");
  const [runtimeHint, setRuntimeHint] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [voiceSignal, setVoiceSignal] = useState({ volume: 0, pitch: 160 });

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const getPreferredVoice = useCallback(async (): Promise<SpeechSynthesisVoice | null> => {
    if (!("speechSynthesis" in window)) {
      return null;
    }

    const synth = window.speechSynthesis;
    let voices = synth.getVoices();

    if (!voices.length) {
      await new Promise<void>((resolve) => {
        const complete = () => {
          synth.removeEventListener("voiceschanged", complete);
          resolve();
        };

        synth.addEventListener("voiceschanged", complete, { once: true });
        window.setTimeout(complete, 450);
      });

      voices = synth.getVoices();
    }

    return pickPreferredFemaleVoice(voices, settings.voice.language);
  }, [settings.voice.language]);

  const clearAutoStop = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  const releaseAudioStream = useCallback(() => {
    setOrbState("idle");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setAudioStream(null);
  }, []);

  const speakResponse = useCallback(
    async (text: string) => {
      if (!("speechSynthesis" in window) || !text.trim()) {
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = settings.voice.language;
      utterance.rate = Math.min(1.4, Math.max(0.75, settings.voice.voiceSpeed / 100));
      utterance.pitch = 1.08;

      const preferredVoice = await getPreferredVoice();
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      await new Promise<void>((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      });
    },
    [getPreferredVoice, settings.voice.language, settings.voice.voiceSpeed],
  );

  const processVoiceChunk = useCallback(
    async (audioChunk: Blob) => {
      setOrbState("thinking");
      setRuntimeHint("Processing voice with ZARA backend...");

      try {
        const response = await sendVoiceChunk(audioChunk, settings.ai.responseMode);
        if (!mountedRef.current) return;

        setAssistantText(response.text);
        setLastTranscript(response.transcript);
        setLastEmotion(response.emotion);
        setVoiceSignal(response.audio_features);

        if (response.action && response.action.type) {
          setRuntimeHint(`Action ${String(response.action.type)} ${String(response.action.status ?? "ready")}`);
        } else {
          setRuntimeHint("");
        }

        setOrbState("speaking");
        await speakResponse(response.text);
      } catch (error) {
        if (!mountedRef.current) return;

        const message = error instanceof Error ? error.message : "Voice request failed";
        setAssistantText("I couldn't process that voice request. Please try again.");
        setRuntimeHint(message);
      } finally {
        if (!mountedRef.current) return;
        setOrbState("idle");
        setIsProcessing(false);
      }
    },
    [settings.ai.responseMode, speakResponse],
  );

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      clearAutoStop();
      return;
    }

    recorder.stop();
    clearAutoStop();
  }, [clearAutoStop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRecording();
      releaseAudioStream();
      clearAutoStop();
      window.speechSynthesis?.cancel();
    };
  }, [clearAutoStop, releaseAudioStream, stopRecording]);

  useEffect(() => {
    let active = true;
    syncBackendMode(settings.ai.responseMode).catch((error) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Unable to sync AI mode";
      setRuntimeHint(message);
    });

    return () => {
      active = false;
    };
  }, [settings.ai.responseMode]);

  const messages = useMemo(() => {
    if (orbState === "listening") {
      return "I'm listening...";
    }
    if (orbState === "thinking") {
      return settings.ai.responseMode === "offline" ? "Processing locally..." : "Thinking...";
    }
    return assistantText;
  }, [assistantText, orbState, settings.ai.responseMode]);

  const subtext = useMemo(() => {
    if (runtimeHint) {
      return runtimeHint;
    }

    if (orbState === "listening") {
      return "Tap once more to send, or wait for auto-send.";
    }

    if (orbState === "speaking") {
      return `Emotion: ${lastEmotion}`;
    }

    if (lastTranscript) {
      return `Heard: ${truncate(lastTranscript, 90)}`;
    }

    return settings.ai.proactiveHints ? "Speak naturally. ZARA can suggest next actions." : "How can I help you?";
  }, [lastEmotion, lastTranscript, orbState, runtimeHint, settings.ai.proactiveHints]);

  const orbVisuals = useMemo(
    () => ({
      hue:
        (orbPaletteHues[settings.orb.palette] +
          (lastEmotion === "happy" ? 14 : lastEmotion === "angry" ? -24 : lastEmotion === "calm" ? 6 : 0) +
          360) %
        360,
      intensity: Math.min(100, Math.max(30, Math.round(settings.orb.intensity * 0.7 + voiceSignal.volume * 30))),
      reactivity: Math.min(100, Math.max(20, Math.round(settings.orb.reactivity * 0.65 + voiceSignal.volume * 35))),
      dimmed: settingsOpen,
    }),
    [lastEmotion, settings.orb.intensity, settings.orb.palette, settings.orb.reactivity, settingsOpen, voiceSignal.volume],
  );

  const handleMicToggle = useCallback(async () => {
    if (isProcessing) {
      return;
    }

    if (orbState === "listening") {
      setIsProcessing(true);
      setRuntimeHint("Sending voice chunk...");
      stopRecording();
      return;
    }

    if (orbState !== "idle") {
      window.speechSynthesis?.cancel();
      setOrbState("idle");
      setRuntimeHint("");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRuntimeHint("This browser does not support microphone recording.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      audioChunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      setAudioStream(stream);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const chunkType = recorder.mimeType || "audio/webm";
        const chunk = new Blob(audioChunksRef.current, { type: chunkType });
        audioChunksRef.current = [];
        recorderRef.current = null;
        releaseAudioStream();

        if (chunk.size === 0) {
          setIsProcessing(false);
          setRuntimeHint("No voice captured. Please try again.");
          return;
        }

        void processVoiceChunk(chunk);
      };

      recorder.start();
      setOrbState("listening");
      setRuntimeHint("Listening...");

      autoStopTimerRef.current = window.setTimeout(() => {
        if (recorder.state !== "inactive") {
          setIsProcessing(true);
          setRuntimeHint("Auto-sending voice chunk...");
          recorder.stop();
        }
      }, AUTO_STOP_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone permission denied";
      setRuntimeHint(message);
      releaseAudioStream();
    }
  }, [isProcessing, orbState, processVoiceChunk, releaseAudioStream, stopRecording]);

  return (
    <div className="relative flex min-h-screen select-none flex-col items-center justify-center overflow-hidden bg-black">
      <TopBar
        mode={settings.ai.responseMode}
        presence={settings.mode.presence}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Orb */}
      <motion.div
        className="relative z-10 flex flex-1 items-center justify-center"
        animate={settingsOpen ? { opacity: 0.55, scale: 1.12, x: -30 } : { opacity: 1, scale: 1.24, x: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <Orb state={orbState} audioStream={audioStream} visuals={orbVisuals} />
      </motion.div>

      {/* Text */}
      <div className="absolute bottom-32 z-10 flex flex-col items-center gap-2 px-6 text-center">
        <AnimatePresence mode="wait">
          <motion.p
            key={messages}
            className="text-sm font-light text-foreground/90 tracking-wide"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            {messages}
          </motion.p>
        </AnimatePresence>
        {subtext && (
          <motion.p
            className="text-xs font-thin text-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
          >
            {subtext}
          </motion.p>
        )}
      </div>

      {/* Mic */}
      <div className="absolute bottom-12 z-10">
        <MicButton isActive={orbState === "listening"} onToggle={handleMicToggle} accentHue={orbVisuals.hue} />
      </div>

      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </div>
  );
};

export default Index;
