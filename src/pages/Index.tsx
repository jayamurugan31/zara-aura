import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ParticleOrb from "@/components/ParticleOrb";
import MicButton from "@/components/MicButton";
import TopBar from "@/components/TopBar";
import { useAudioAnalysis } from "@/hooks/useAudioAnalysis";

type OrbState = "idle" | "listening" | "thinking" | "speaking" | "processing";
type Emotion = "neutral" | "happy" | "angry" | "calm" | "curious";
type AIMode = "Online" | "Smart" | "Offline";
type ModeType = "Virtual" | "Physical";
type Personality = "Professional" | "Friendly" | "Assistant" | "Energetic";
type Language = "English" | "Tamil" | "Hindi";

const stateMessages: Record<OrbState, string> = {
  idle: "Hello, I'm ZARA.",
  listening: "I'm listening…",
  thinking: "Let me think…",
  speaking: "Here's what I found.",
  processing: "Processing…",
};

const stateSubtext: Record<OrbState, string> = {
  idle: "How can I help you?",
  listening: "",
  thinking: "",
  speaking: "",
  processing: "",
};

const Index = () => {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [aiMode, setAIMode] = useState<AIMode>("Smart");
  const [modeType, setModeType] = useState<ModeType>("Virtual");
  const [personality, setPersonality] = useState<Personality>("Assistant");
  const [language, setLanguage] = useState<Language>("English");
  const [contextText, setContextText] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const { audioData, isAnalyzing, startAnalysis, stopAnalysis } = useAudioAnalysis();
  const timeoutsRef = useRef<NodeJS.Timeout[]>([]);

  // Mouse tracking for parallax
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      setMousePos({
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: (e.clientY / window.innerHeight) * 2 - 1,
      });
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, []);

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  const handleMicToggle = useCallback(() => {
    if (orbState === "idle") {
      startAnalysis();
      setOrbState("listening");
      setEmotion("curious");

      const t1 = setTimeout(() => {
        setOrbState("processing");
        setEmotion("neutral");
        setContextText("Analyzing your request…");
      }, 3000);

      const t2 = setTimeout(() => {
        setOrbState("thinking");
        setContextText("Searching for answers…");
        setEmotion("calm");
      }, 4500);

      const t3 = setTimeout(() => {
        stopAnalysis();
        setOrbState("speaking");
        setEmotion("happy");
        setContextText(
          modeType === "Physical" ? "Turning on lights…" : "Opening browser…"
        );
      }, 6500);

      const t4 = setTimeout(() => {
        setOrbState("idle");
        setEmotion("neutral");
        setContextText(null);
      }, 9500);

      timeoutsRef.current = [t1, t2, t3, t4];
    } else {
      clearTimeouts();
      stopAnalysis();
      setOrbState("idle");
      setEmotion("neutral");
      setContextText(null);
    }
  }, [orbState, modeType, startAnalysis, stopAnalysis, clearTimeouts]);

  // Cleanup on unmount
  useEffect(() => () => clearTimeouts(), [clearTimeouts]);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-background overflow-hidden select-none">
      <TopBar
        aiMode={aiMode}
        onAIModeChange={setAIMode}
        modeType={modeType}
        onModeTypeChange={setModeType}
        personality={personality}
        onPersonalityChange={setPersonality}
        language={language}
        onLanguageChange={setLanguage}
      />

      {/* Physical mode indicators */}
      <AnimatePresence>
        {modeType === "Physical" && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-14 right-6 flex items-center gap-3 z-10"
          >
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500/70 animate-pulse" />
              <span className="text-[9px] font-light text-muted-foreground/40">IoT Connected</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-primary/50" />
              <span className="text-[9px] font-light text-muted-foreground/40">3 Devices</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Orb */}
      <div className="flex-1 flex items-center justify-center">
        <ParticleOrb
          state={orbState}
          audioData={audioData}
          emotion={emotion}
          mousePos={mousePos}
        />
      </div>

      {/* Text */}
      <div className="absolute bottom-32 flex flex-col items-center gap-2">
        <AnimatePresence mode="wait">
          <motion.p
            key={stateMessages[orbState]}
            className="text-sm font-light text-foreground/90 tracking-wide"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            {stateMessages[orbState]}
          </motion.p>
        </AnimatePresence>
        {stateSubtext[orbState] && (
          <motion.p
            className="text-xs font-thin text-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
          >
            {stateSubtext[orbState]}
          </motion.p>
        )}
      </div>

      {/* Context feedback */}
      <AnimatePresence>
        {contextText && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.4 }}
            className="absolute bottom-48 text-[11px] font-light text-primary/60 tracking-wide"
          >
            {contextText}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mic */}
      <div className="absolute bottom-12">
        <MicButton isActive={orbState === "listening"} onToggle={handleMicToggle} />
      </div>
    </div>
  );
};

export default Index;
