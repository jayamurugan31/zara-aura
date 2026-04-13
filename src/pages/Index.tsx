import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Orb from "@/components/Orb";
import MicButton from "@/components/MicButton";
import SettingsPanel from "@/components/SettingsPanel";
import TopBar from "@/components/TopBar";
import { defaultSettings, orbPaletteHues, type ZaraSettings } from "@/lib/settings";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const Index = () => {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ZaraSettings>(defaultSettings);

  const streamRef = useRef<MediaStream | null>(null);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];
  }, []);

  const stopVoiceSession = useCallback(() => {
    clearTimers();
    setOrbState("idle");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setAudioStream(null);
  }, [clearTimers]);

  useEffect(
    () => () => {
      stopVoiceSession();
    },
    [stopVoiceSession],
  );

  const processingProfile = useMemo(() => {
    const speedFactor = settings.voice.voiceSpeed / 100;
    const listeningDelay = 1700 + (100 - settings.voice.micSensitivity) * 14;
    const modeBias =
      settings.ai.responseMode === "offline" ? 1200 : settings.ai.responseMode === "online" ? 600 : 900;
    const reasoningBias = settings.ai.adaptiveReasoning ? 320 : -120;
    const privacyBias = settings.privacy.onDeviceOnly ? 260 : 0;
    const speakingBias = settings.mode.presence === "physical" ? 350 : 0;
    const thinkingWindow = Math.max(900, modeBias + reasoningBias + privacyBias);
    const speakingWindow = Math.max(1400, Math.round(2600 / speedFactor) + speakingBias);

    return {
      toThinking: Math.round(listeningDelay),
      toSpeaking: Math.round(listeningDelay + thinkingWindow),
      toIdle: Math.round(listeningDelay + thinkingWindow + speakingWindow),
    };
  }, [
    settings.ai.adaptiveReasoning,
    settings.ai.responseMode,
    settings.mode.presence,
    settings.privacy.onDeviceOnly,
    settings.voice.micSensitivity,
    settings.voice.voiceSpeed,
  ]);

  const messages = useMemo<Record<OrbState, string>>(() => {
    const idleMessage =
      settings.personality.tone === "expressive"
        ? "Hello, I'm ZARA. Let's build something remarkable."
        : settings.personality.tone === "concise"
          ? "ZARA is ready."
          : "Hello, I'm ZARA.";

    const thinkingMessage =
      settings.ai.responseMode === "offline" || settings.privacy.onDeviceOnly
        ? "Processing locally..."
        : "Let me think...";

    const speakingMessage =
      settings.mode.presence === "physical"
        ? "Transmitting output to physical channel."
        : "Here's what I found.";

    return {
      idle: idleMessage,
      listening: "I'm listening...",
      thinking: thinkingMessage,
      speaking: speakingMessage,
    };
  }, [
    settings.ai.responseMode,
    settings.mode.presence,
    settings.personality.tone,
    settings.privacy.onDeviceOnly,
  ]);

  const subtext = useMemo<Record<OrbState, string>>(
    () => ({
      idle: settings.ai.proactiveHints ? "Speak naturally. ZARA can suggest next actions." : "How can I help you?",
      listening: "",
      thinking: "",
      speaking: "",
    }),
    [settings.ai.proactiveHints],
  );

  const orbVisuals = useMemo(
    () => ({
      hue: orbPaletteHues[settings.orb.palette],
      intensity: settings.orb.intensity,
      reactivity: settings.orb.reactivity,
      dimmed: settingsOpen,
    }),
    [settings.orb.intensity, settings.orb.palette, settings.orb.reactivity, settingsOpen],
  );

  const handleMicToggle = useCallback(async () => {
    if (orbState === "idle") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        clearTimers();
        streamRef.current = stream;
        setAudioStream(stream);
        setOrbState("listening");

        timersRef.current.push(window.setTimeout(() => setOrbState("thinking"), processingProfile.toThinking));
        timersRef.current.push(window.setTimeout(() => setOrbState("speaking"), processingProfile.toSpeaking));
        timersRef.current.push(window.setTimeout(stopVoiceSession, processingProfile.toIdle));
      } catch {
        console.warn("Mic access denied");
      }
    } else {
      stopVoiceSession();
    }
  }, [clearTimers, orbState, processingProfile.toIdle, processingProfile.toSpeaking, processingProfile.toThinking, stopVoiceSession]);

  return (
    <div className="relative flex min-h-screen select-none flex-col items-center justify-center overflow-hidden bg-black">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_35%,rgba(255,255,255,0.06),transparent_42%)]" />

      <TopBar
        mode={settings.ai.responseMode}
        presence={settings.mode.presence}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Orb */}
      <motion.div
        className="relative z-10 flex flex-1 items-center justify-center"
        animate={settingsOpen ? { opacity: 0.55, scale: 0.95, x: -24 } : { opacity: 1, scale: 1, x: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <Orb state={orbState} audioStream={audioStream} visuals={orbVisuals} />
      </motion.div>

      {/* Text */}
      <div className="absolute bottom-32 z-10 flex flex-col items-center gap-2 px-6 text-center">
        <AnimatePresence mode="wait">
          <motion.p
            key={messages[orbState]}
            className="text-sm font-light text-foreground/90 tracking-wide"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            {messages[orbState]}
          </motion.p>
        </AnimatePresence>
        {subtext[orbState] && (
          <motion.p
            className="text-xs font-thin text-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
          >
            {subtext[orbState]}
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
