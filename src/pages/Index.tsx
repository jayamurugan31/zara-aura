import { useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Orb from "@/components/Orb";
import MicButton from "@/components/MicButton";
import TopBar from "@/components/TopBar";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const messages: Record<OrbState, string> = {
  idle: "Hello, I'm ZARA.",
  listening: "I'm listening…",
  thinking: "Let me think…",
  speaking: "Here's what I found.",
};

const subtext: Record<OrbState, string> = {
  idle: "How can I help you?",
  listening: "",
  thinking: "",
  speaking: "",
};

const Index = () => {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const handleMicToggle = useCallback(async () => {
    if (orbState === "idle") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        setAudioStream(stream);
        setOrbState("listening");

        setTimeout(() => setOrbState("thinking"), 3000);
        setTimeout(() => setOrbState("speaking"), 5000);
        setTimeout(() => {
          setOrbState("idle");
          streamRef.current?.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          setAudioStream(null);
        }, 8000);
      } catch {
        console.warn("Mic access denied");
      }
    } else {
      setOrbState("idle");
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      setAudioStream(null);
    }
  }, [orbState]);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-background overflow-hidden select-none">
      <TopBar />

      {/* Orb */}
      <div className="flex-1 flex items-center justify-center">
        <Orb state={orbState} audioStream={audioStream} />
      </div>

      {/* Text */}
      <div className="absolute bottom-32 flex flex-col items-center gap-2">
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
      <div className="absolute bottom-12">
        <MicButton isActive={orbState === "listening"} onToggle={handleMicToggle} />
      </div>
    </div>
  );
};

export default Index;
