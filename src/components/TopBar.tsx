import { Settings2 } from "lucide-react";

import type { PresenceMode, ResponseMode } from "@/lib/settings";

interface TopBarProps {
  mode: ResponseMode;
  presence: PresenceMode;
  continuousLoop?: boolean;
  onOpenSettings: () => void;
}

const modeLabel: Record<ResponseMode, string> = {
  online: "Online",
  smart: "Smart",
  offline: "Offline",
};

const presenceLabel: Record<PresenceMode, string> = {
  virtual: "Virtual",
  physical: "Physical",
};

const TopBar = ({ mode, presence, continuousLoop = false, onOpenSettings }: TopBarProps) => {
  return (
    <div className="fixed left-0 right-0 top-0 z-20 flex items-center justify-between px-5 py-4 sm:px-7">
      <span className="text-[11px] font-light uppercase tracking-[0.32em] text-white/58">ZARA</span>

      <div className="flex items-center gap-2">
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-light uppercase tracking-[0.18em] text-white/55">
          {modeLabel[mode]}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-light uppercase tracking-[0.18em] text-white/55">
          {presenceLabel[presence]}
        </span>
        {continuousLoop ? (
          <span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 text-[10px] font-light uppercase tracking-[0.18em] text-cyan-100/85">
            Loop
          </span>
        ) : null}
        <button
          type="button"
          onClick={onOpenSettings}
          className="group rounded-full border border-white/12 bg-white/[0.03] p-2 text-white/65 transition-all duration-300 hover:border-cyan-300/35 hover:text-[#EAEAEA] hover:shadow-[0_0_20px_rgba(34,211,238,0.16)]"
          aria-label="Open settings"
        >
          <Settings2 className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" />
        </button>
      </div>
    </div>
  );
};

export default TopBar;
