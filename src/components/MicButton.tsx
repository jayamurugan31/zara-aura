import { motion } from "framer-motion";
import { Mic } from "lucide-react";

interface MicButtonProps {
  isActive: boolean;
  onToggle: () => void;
}

const MicButton = ({ isActive, onToggle }: MicButtonProps) => {
  return (
    <motion.button
      onClick={onToggle}
      className="relative flex items-center justify-center w-14 h-14 rounded-full bg-secondary text-foreground transition-colors"
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.95 }}
      animate={isActive ? { scale: [1, 1.05, 1] } : {}}
      transition={isActive ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
    >
      {isActive && (
        <motion.div
          className="absolute inset-0 rounded-full border border-primary/30"
          animate={{ scale: [1, 1.4], opacity: [0.5, 0] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <Mic className={`w-5 h-5 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
    </motion.button>
  );
};

export default MicButton;
