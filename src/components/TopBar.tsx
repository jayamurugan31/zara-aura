import { useState } from "react";

const modes = ["Online", "Smart", "Offline"] as const;

const TopBar = () => {
  const [mode, setMode] = useState<typeof modes[number]>("Smart");

  return (
    <div className="fixed top-0 left-0 right-0 flex items-center justify-between px-6 py-4 z-10">
      <span className="text-xs font-light tracking-[0.3em] text-muted-foreground/60 uppercase">
        Zara
      </span>
      <div className="flex items-center gap-1">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 text-[11px] font-light rounded-full transition-all duration-300 ${
              mode === m
                ? "text-foreground bg-secondary"
                : "text-muted-foreground/40 hover:text-muted-foreground/60"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
};

export default TopBar;
