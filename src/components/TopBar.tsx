import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

type AIMode = "Online" | "Smart" | "Offline";
type ModeType = "Virtual" | "Physical";
type Personality = "Professional" | "Friendly" | "Assistant" | "Energetic";
type Language = "English" | "Tamil" | "Hindi";

interface TopBarProps {
  aiMode: AIMode;
  onAIModeChange: (mode: AIMode) => void;
  modeType: ModeType;
  onModeTypeChange: (mode: ModeType) => void;
  personality: Personality;
  onPersonalityChange: (p: Personality) => void;
  language: Language;
  onLanguageChange: (l: Language) => void;
}

const aiModes: AIMode[] = ["Online", "Smart", "Offline"];
const modeTypes: ModeType[] = ["Virtual", "Physical"];
const personalities: Personality[] = ["Professional", "Friendly", "Assistant", "Energetic"];
const languages: Language[] = ["English", "Tamil", "Hindi"];

function PillToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center bg-secondary/40 rounded-full p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`relative px-3 py-1 text-[10px] font-light rounded-full transition-all duration-300 ${
            value === opt
              ? "text-foreground"
              : "text-muted-foreground/40 hover:text-muted-foreground/60"
          }`}
        >
          {value === opt && (
            <motion.div
              layoutId={`pill-${options.join()}`}
              className="absolute inset-0 bg-secondary rounded-full"
              transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
            />
          )}
          <span className="relative z-10">{opt}</span>
        </button>
      ))}
    </div>
  );
}

function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-light text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors rounded-full"
      >
        <span className="text-muted-foreground/30 mr-0.5">{label}</span>
        {value}
        <ChevronDown className="w-2.5 h-2.5" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-1 z-50 bg-card/95 backdrop-blur-sm border border-border/30 rounded-lg py-1 min-w-[100px]"
            >
              {options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    onChange(opt);
                    setOpen(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-[10px] font-light transition-colors ${
                    value === opt
                      ? "text-foreground bg-secondary/40"
                      : "text-muted-foreground/50 hover:text-foreground hover:bg-secondary/20"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

const TopBar = ({
  aiMode,
  onAIModeChange,
  modeType,
  onModeTypeChange,
  personality,
  onPersonalityChange,
  language,
  onLanguageChange,
}: TopBarProps) => {
  return (
    <div className="fixed top-0 left-0 right-0 flex items-center justify-between px-6 py-3 z-10">
      <span className="text-xs font-light tracking-[0.3em] text-muted-foreground/60 uppercase">
        Zara
      </span>
      <div className="flex items-center gap-3">
        <PillToggle options={aiModes} value={aiMode} onChange={onAIModeChange} />
        <div className="w-px h-4 bg-border/20" />
        <PillToggle options={modeTypes} value={modeType} onChange={onModeTypeChange} />
        <div className="w-px h-4 bg-border/20" />
        <Dropdown label="🎭" value={personality} options={personalities} onChange={onPersonalityChange} />
        <Dropdown label="🌍" value={language} options={languages} onChange={onLanguageChange} />
      </div>
    </div>
  );
};

export default TopBar;
