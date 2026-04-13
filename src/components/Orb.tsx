import { motion } from "framer-motion";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface OrbProps {
  state: OrbState;
}

const stateConfig = {
  idle: {
    scale: [1, 1.05, 1],
    transition: { duration: 4, repeat: Infinity, ease: "easeInOut" },
  },
  listening: {
    scale: [1, 1.12, 1.08, 1.12, 1],
    transition: { duration: 2, repeat: Infinity, ease: "easeInOut" },
  },
  thinking: {
    scale: [1, 1.03, 1],
    rotate: [0, 360],
    transition: { duration: 6, repeat: Infinity, ease: "linear" },
  },
  speaking: {
    scale: [1, 1.08, 0.97, 1.06, 1],
    transition: { duration: 1.2, repeat: Infinity, ease: "easeInOut" },
  },
};

const Orb = ({ state }: OrbProps) => {
  const config = stateConfig[state];

  return (
    <div className="relative flex items-center justify-center">
      {/* Outer glow */}
      <motion.div
        className="absolute w-48 h-48 rounded-full"
        style={{
          background: "radial-gradient(circle, hsl(190 100% 50% / 0.08) 0%, transparent 70%)",
        }}
        animate={{ scale: state === "listening" ? [1, 1.3, 1] : [1, 1.15, 1] }}
        transition={{ duration: state === "listening" ? 2 : 4, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Ring */}
      <motion.div
        className="absolute w-36 h-36 rounded-full border border-orb-glow/10"
        animate={{ rotate: 360 }}
        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
      />

      {/* Core orb */}
      <motion.div
        className="relative w-28 h-28 rounded-full animate-orb-pulse"
        style={{
          background: "radial-gradient(circle at 40% 40%, hsl(190 80% 70% / 0.9), hsl(190 100% 50% / 0.4) 50%, hsl(190 100% 50% / 0.05) 100%)",
        }}
        animate={config}
        transition={config.transition}
      />
    </div>
  );
};

export default Orb;
