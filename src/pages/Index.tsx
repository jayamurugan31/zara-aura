import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Orb from "@/components/Orb";
import MicButton from "@/components/MicButton";
import SettingsPanel from "@/components/SettingsPanel";
import TopBar from "@/components/TopBar";
import { defaultSettings, orbPaletteHues, type VoicePersona, type ZaraSettings } from "@/lib/settings";
import { sendVoiceChunk, syncBackendMode, type BackendAction, type BackendEmotion } from "@/lib/backend";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const AUTO_STOP_MS = 4500;
const LOOP_RESTART_DELAY_MS = 520;

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

function normalizeSpeechLanguageTag(language: string | undefined, fallback: string): string {
  if (!language) {
    return fallback;
  }

  const lowered = language.trim().toLowerCase();
  if (!lowered) {
    return fallback;
  }

  if (lowered.includes("-")) {
    return lowered;
  }

  const codeMap: Record<string, string> = {
    ar: "ar-SA",
    as: "as-IN",
    bn: "bn-IN",
    de: "de-DE",
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    gu: "gu-IN",
    hi: "hi-IN",
    it: "it-IT",
    ja: "ja-JP",
    kn: "kn-IN",
    ko: "ko-KR",
    ml: "ml-IN",
    mr: "mr-IN",
    ne: "ne-NP",
    or: "or-IN",
    pa: "pa-IN",
    nl: "nl-NL",
    pt: "pt-BR",
    ru: "ru-RU",
    ta: "ta-IN",
    te: "te-IN",
    tr: "tr-TR",
    ur: "ur-PK",
    zh: "zh-CN",
  };

  return codeMap[lowered] ?? fallback;
}

function actionString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const femaleVoiceMarkers = [
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

const maleVoiceMarkers = [
  "male",
  "man",
  "david",
  "mark",
  "james",
  "daniel",
  "george",
  "alex",
  "ryan",
  "john",
];

function pickPreferredVoice(
  voices: SpeechSynthesisVoice[],
  language: string,
  persona: VoicePersona,
): SpeechSynthesisVoice | null {
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

  const matchByMarkers = (markers: string[]) =>
    pool.find((voice) => {
      const name = voice.name.toLowerCase();
      return markers.some((marker) => name.includes(marker));
    }) ?? null;

  if (persona === "female") {
    return matchByMarkers(femaleVoiceMarkers) ?? pool[0] ?? null;
  }

  if (persona === "male") {
    return matchByMarkers(maleVoiceMarkers) ?? pool[0] ?? null;
  }

  const defaultVoice = pool.find((voice) => voice.default);
  return defaultVoice ?? matchByMarkers(femaleVoiceMarkers) ?? pool[0] ?? null;
}

const Index = () => {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ZaraSettings>(defaultSettings);
  const [assistantText, setAssistantText] = useState("Hello, I'm ZARA.");
  const [lastTranscript, setLastTranscript] = useState("");
  const [lastLanguage, setLastLanguage] = useState("en");
  const [lastEmotion, setLastEmotion] = useState<BackendEmotion>("neutral");
  const [runtimeHint, setRuntimeHint] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [voiceSignal, setVoiceSignal] = useState({ volume: 0, pitch: 160 });

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<number | null>(null);
  const loopRestartTimerRef = useRef<number | null>(null);
  const processVoiceChunkRef = useRef<(audioChunk: Blob) => Promise<void>>(async () => undefined);
  const isProcessingRef = useRef(false);
  const mountedRef = useRef(true);

  const getPreferredVoice = useCallback(async (languageTag: string): Promise<SpeechSynthesisVoice | null> => {
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

    return pickPreferredVoice(voices, languageTag, settings.voice.persona);
  }, [settings.voice.persona]);

  const clearAutoStop = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  const clearLoopRestart = useCallback(() => {
    if (loopRestartTimerRef.current !== null) {
      window.clearTimeout(loopRestartTimerRef.current);
      loopRestartTimerRef.current = null;
    }
  }, []);

  const releaseAudioStream = useCallback(() => {
    setOrbState("idle");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setAudioStream(null);
  }, []);

  const handleAutomationAction = useCallback(
    (action: BackendAction | null): string | null => {
      if (!action) {
        return null;
      }

      const actionType = actionString(action.type) ?? "automation";
      const actionStatus = actionString(action.status) ?? "planned";
      const mcpTool = actionString(action.mcp_tool);
      const target = actionString(action.target) ?? actionString(action.mcp_url);
      const actionError = actionString(action.error);

      if (actionStatus === "executed" || actionStatus === "executed_fallback") {
        return `Action ${actionType} executed`;
      }

      if (actionStatus === "failed") {
        return actionError ? `Action ${actionType} failed: ${actionError}` : `Action ${actionType} failed`;
      }

      if (settings.automation.routines && mcpTool === "open_url" && target && actionStatus === "planned") {
        const popup = window.open(target, "_blank", "noopener,noreferrer");
        if (popup) {
          return `Action ${actionType} executed`;
        }
        return `Action ${actionType} blocked by browser popup settings`;
      }

      return `Action ${actionType} ${actionStatus}`;
    },
    [settings.automation.routines],
  );

  const startListening = useCallback(
    async (fromLoop = false) => {
      if (isProcessingRef.current) {
        return;
      }

      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setRuntimeHint("This browser does not support microphone recording.");
        return;
      }

      clearLoopRestart();
      clearAutoStop();

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

          void processVoiceChunkRef.current(chunk);
        };

        recorder.start();
        setOrbState("listening");
        setRuntimeHint(fromLoop ? "Continuous loop listening..." : "Listening...");

        autoStopTimerRef.current = window.setTimeout(() => {
          if (recorder.state !== "inactive") {
            setIsProcessing(true);
            setRuntimeHint(fromLoop ? "Loop: sending voice chunk..." : "Auto-sending voice chunk...");
            recorder.stop();
          }
        }, AUTO_STOP_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Microphone permission denied";
        setRuntimeHint(message);
        releaseAudioStream();
      }
    },
    [clearAutoStop, clearLoopRestart, releaseAudioStream],
  );

  const speakResponse = useCallback(
    async (text: string, spokenLanguage?: string) => {
      if (!("speechSynthesis" in window) || !text.trim()) {
        return;
      }

      window.speechSynthesis.cancel();
      const resolvedLanguage = normalizeSpeechLanguageTag(spokenLanguage, settings.voice.language);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = resolvedLanguage;
      utterance.rate = Math.min(1.4, Math.max(0.75, settings.voice.voiceSpeed / 100));
      utterance.pitch = settings.voice.persona === "male" ? 0.94 : settings.voice.persona === "female" ? 1.08 : 1;

      const preferredVoice = await getPreferredVoice(resolvedLanguage);
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      await new Promise<void>((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      });
    },
    [getPreferredVoice, settings.voice.language, settings.voice.persona, settings.voice.voiceSpeed],
  );

  const processVoiceChunk = useCallback(
    async (audioChunk: Blob) => {
      let shouldContinueLoop = false;

      setOrbState("thinking");
      setRuntimeHint("Processing voice with ZARA backend...");

      try {
        const response = await sendVoiceChunk(audioChunk, settings.ai.responseMode);
        if (!mountedRef.current) return;

        setAssistantText(response.text);
        setLastTranscript(response.transcript);
        setLastEmotion(response.emotion);
        setLastLanguage(response.language);
        setVoiceSignal(response.audio_features);

        const actionRuntimeHint = handleAutomationAction(response.action);
        if (actionRuntimeHint) {
          setRuntimeHint(actionRuntimeHint);
        } else {
          setRuntimeHint("");
        }

        setOrbState("speaking");
        await speakResponse(response.text, response.language);
        shouldContinueLoop = true;
      } catch (error) {
        if (!mountedRef.current) return;

        const message = error instanceof Error ? error.message : "Voice request failed";
        setAssistantText("I couldn't process that voice request. Please try again.");
        setRuntimeHint(message);
      } finally {
        if (!mountedRef.current) return;
        setOrbState("idle");
        setIsProcessing(false);

        if (shouldContinueLoop && settings.ai.continuousLoop) {
          setRuntimeHint("Continuous loop active...");
          clearLoopRestart();
          loopRestartTimerRef.current = window.setTimeout(() => {
            if (!mountedRef.current) {
              return;
            }
            if (isProcessingRef.current) {
              return;
            }
            void startListening(true);
          }, LOOP_RESTART_DELAY_MS);
        }
      }
    },
    [clearLoopRestart, handleAutomationAction, settings.ai.continuousLoop, settings.ai.responseMode, speakResponse, startListening],
  );

  useEffect(() => {
    processVoiceChunkRef.current = processVoiceChunk;
  }, [processVoiceChunk]);

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
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRecording();
      releaseAudioStream();
      clearAutoStop();
      clearLoopRestart();
      window.speechSynthesis?.cancel();
    };
  }, [clearAutoStop, clearLoopRestart, releaseAudioStream, stopRecording]);

  useEffect(() => {
    if (!settings.ai.continuousLoop) {
      clearLoopRestart();
    }
  }, [clearLoopRestart, settings.ai.continuousLoop]);

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
      return settings.ai.continuousLoop
        ? "Loop mode on. Tap once to send or pause between turns."
        : "Tap once more to send, or wait for auto-send.";
    }

    if (orbState === "speaking") {
      return `Emotion: ${lastEmotion} | Lang: ${lastLanguage}`;
    }

    if (lastTranscript) {
      return `Heard: ${truncate(lastTranscript, 90)}`;
    }

    if (settings.ai.continuousLoop) {
      return "Continuous loop is active. ZARA will keep listening after replies.";
    }

    return settings.ai.proactiveHints ? "Speak naturally. ZARA can suggest next actions." : "How can I help you?";
  }, [lastEmotion, lastLanguage, lastTranscript, orbState, runtimeHint, settings.ai.continuousLoop, settings.ai.proactiveHints]);

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
    if (isProcessingRef.current) {
      return;
    }

    if (orbState === "listening") {
      setIsProcessing(true);
      setRuntimeHint("Sending voice chunk...");
      stopRecording();
      return;
    }

    if (orbState !== "idle") {
      clearLoopRestart();
      clearAutoStop();
      window.speechSynthesis?.cancel();
      releaseAudioStream();
      setOrbState("idle");
      setIsProcessing(false);
      setRuntimeHint("");
      return;
    }

    await startListening(false);
  }, [clearAutoStop, clearLoopRestart, orbState, releaseAudioStream, startListening, stopRecording]);

  return (
    <div className="relative flex min-h-screen select-none flex-col items-center justify-center overflow-hidden bg-black">
      <TopBar
        mode={settings.ai.responseMode}
        presence={settings.mode.presence}
        continuousLoop={settings.ai.continuousLoop}
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
