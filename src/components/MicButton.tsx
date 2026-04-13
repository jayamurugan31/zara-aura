import { motion } from "framer-motion";
import { Mic } from "lucide-react";

interface MicButtonProps {
  isActive: boolean;
  onToggle: () => void;
  accentHue?: number;
}

const MicButton = ({ isActive, onToggle, accentHue = 190 }: MicButtonProps) => {
  const glowColor = `hsla(${accentHue}, 90%, 68%, 0.32)`;

  return (
    <motion.button
      onClick={onToggle}
      className="relative flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-black/70 text-foreground backdrop-blur-sm transition-colors"
      style={{ boxShadow: isActive ? `0 0 28px ${glowColor}` : "0 0 0 transparent" }}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.95 }}
      animate={isActive ? { scale: [1, 1.05, 1] } : {}}
      transition={isActive ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
    >
      {isActive && (
        <motion.div
          className="absolute inset-0 rounded-full border"
          style={{ borderColor: `hsla(${accentHue}, 88%, 70%, 0.38)` }}
          animate={{ scale: [1, 1.4], opacity: [0.5, 0] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <Mic className="h-5 w-5 text-white/72" />
    </motion.button>
  );
};

export default MicButton;
