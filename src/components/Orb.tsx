import { useRef, useEffect, useCallback } from "react";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface OrbProps {
  state: OrbState;
  audioStream?: MediaStream | null;
  visuals?: {
    hue: number;
    intensity: number;
    reactivity: number;
    dimmed?: boolean;
  };
}

interface Particle {
  // base spherical coords
  theta: number;
  phi: number;
  baseR: number;
  // current offset from base
  offsetR: number;
  offsetVel: number;
  // scatter amount (how far from surface)
  scatter: number;
  size: number;
  opacity: number;
}

const PARTICLE_COUNT = 900;
const BASE_RADIUS = 165;
const CANVAS_SIZE = 520;
const RENDERED_SIZE = "min(84vw, 560px)";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createParticles(): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // fibonacci sphere distribution
    const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2;
    const radiusAtY = Math.sqrt(1 - y * y);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const theta = goldenAngle * i;
    const phi = Math.acos(y);

    particles.push({
      theta,
      phi,
      baseR: BASE_RADIUS,
      offsetR: (Math.random() - 0.5) * 30,
      offsetVel: (Math.random() - 0.5) * 0.3,
      scatter: 0.8 + Math.random() * 0.4,
      size: 0.8 + Math.random() * 1.5,
      opacity: 0.3 + Math.random() * 0.7,
    });
  }
  return particles;
}

const Orb = ({ state, audioStream, visuals }: OrbProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>(createParticles());
  const frameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const timeRef = useRef(0);
  const stateRef = useRef<OrbState>(state);
  const visualsRef = useRef({
    hue: 190,
    intensity: 68,
    reactivity: 72,
    dimmed: false,
  });

  stateRef.current = state;
  visualsRef.current = {
    hue: visuals?.hue ?? 190,
    intensity: visuals?.intensity ?? 68,
    reactivity: visuals?.reactivity ?? 72,
    dimmed: visuals?.dimmed ?? false,
  };

  // Setup audio analyser when stream changes
  useEffect(() => {
    if (!audioStream) {
      analyserRef.current = null;
      dataArrayRef.current = null;
      return;
    }

    try {
      const ctx = audioCtxRef.current || new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(audioStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      console.warn("Audio analyser setup failed:", e);
    }

    return () => {
      // cleanup handled by stream ending
    };
  }, [audioStream]);

  const getAudioLevel = useCallback((): { bass: number; mid: number; high: number; overall: number } => {
    if (!analyserRef.current || !dataArrayRef.current) {
      return { bass: 0, mid: 0, high: 0, overall: 0 };
    }
    const data = dataArrayRef.current;
    analyserRef.current.getByteFrequencyData(data);
    const len = data.length;
    let bass = 0, mid = 0, high = 0;
    const bassEnd = Math.floor(len * 0.15);
    const midEnd = Math.floor(len * 0.5);

    for (let i = 0; i < len; i++) {
      const v = data[i] / 255;
      if (i < bassEnd) bass += v;
      else if (i < midEnd) mid += v;
      else high += v;
    }
    bass /= bassEnd || 1;
    mid /= (midEnd - bassEnd) || 1;
    high /= (len - midEnd) || 1;
    const overall = (bass + mid + high) / 3;
    return { bass, mid, high, overall };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = CANVAS_SIZE;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const particles = particlesRef.current;
    const cx = size / 2;
    const cy = size / 2;

    const animate = () => {
      timeRef.current += 0.016;
      const t = timeRef.current;
      const currentState = stateRef.current;
      const currentVisuals = visualsRef.current;
      const audio = getAudioLevel();
      const intensityFactor = 0.55 + currentVisuals.intensity / 100;
      const reactivityFactor = 0.35 + currentVisuals.reactivity / 100;
      const dimFactor = currentVisuals.dimmed ? 0.6 : 1;
      const stateHueOffset =
        currentState === "listening" ? 16 : currentState === "thinking" ? -20 : currentState === "speaking" ? 30 : 0;
      const hueOscillation = Math.sin(t * 0.85) * 12 + Math.cos(t * 0.37) * 6;
      const audioHueBoost = audio.overall * 28;
      const dynamicBaseHue = (currentVisuals.hue + stateHueOffset + hueOscillation + audioHueBoost + 360) % 360;
      const baseSaturation =
        currentVisuals.hue === 0
          ? 8 + audio.overall * 24 + reactivityFactor * 6
          : 64 + currentVisuals.intensity * 0.16 + Math.sin(t * 1.2) * 8 + audio.overall * 18;
      const baseLightness =
        currentVisuals.hue === 0
          ? 86 + Math.sin(t * 1.1) * 4 + audio.overall * 6
          : 74 + Math.cos(t * 1.1) * 6 + audio.overall * 10;
      const saturation = clamp(baseSaturation, currentVisuals.hue === 0 ? 5 : 48, currentVisuals.hue === 0 ? 35 : 98);
      const lightness = clamp(baseLightness, 58, 94);

      ctx.clearRect(0, 0, size, size);

      // State-dependent params
      let rotationSpeed = 0.15;
      let breatheAmp = 3;
      let breatheSpeed = 0.5;
      let scatterMultiplier = 1;
      let turbulence = 0;

      switch (currentState) {
        case "idle":
          rotationSpeed = 0.15;
          breatheAmp = 3;
          breatheSpeed = 0.5;
          scatterMultiplier = 1;
          break;
        case "listening":
          rotationSpeed = 0.3;
          breatheAmp = 8 + audio.overall * 30;
          breatheSpeed = 1;
          scatterMultiplier = 1 + audio.bass * 1.5;
          turbulence = audio.high * 15;
          break;
        case "thinking":
          rotationSpeed = 0.6;
          breatheAmp = 5;
          breatheSpeed = 0.8;
          scatterMultiplier = 1.1;
          turbulence = 3;
          break;
        case "speaking":
          rotationSpeed = 0.25;
          breatheAmp = 10 + audio.overall * 25;
          breatheSpeed = 1.2;
          scatterMultiplier = 1 + audio.mid * 1.2;
          turbulence = audio.high * 10;
          break;
      }

          rotationSpeed *= 0.75 + intensityFactor * 0.28;
          breatheAmp *= intensityFactor;
          turbulence *= reactivityFactor;

      const breathe = Math.sin(t * breatheSpeed) * breatheAmp;
      const rotation = t * rotationSpeed;

      // Sort particles by depth for proper rendering
      const projected: { x: number; y: number; z: number; size: number; opacity: number }[] = [];

      for (const p of particles) {
        // Update offset with spring-like behavior
        const targetOffset = turbulence * Math.sin(t * 3 + p.theta * 5 + p.phi * 3);
        p.offsetVel += (targetOffset - p.offsetR) * 0.05;
        p.offsetVel *= 0.92;
        p.offsetR += p.offsetVel;

        const r = (p.baseR + breathe + p.offsetR) * p.scatter * scatterMultiplier;
        const theta = p.theta + rotation;
        const phi = p.phi;

        // 3D to 2D projection
        const x3d = r * Math.sin(phi) * Math.cos(theta);
        const y3d = r * Math.cos(phi);
        const z3d = r * Math.sin(phi) * Math.sin(theta);

        // Simple perspective
        const perspective = 540;
        const scale = perspective / (perspective + z3d + 240);
        const x2d = cx + x3d * scale;
        const y2d = cy + y3d * scale;

        const depthOpacity = 0.15 + 0.85 * ((z3d + BASE_RADIUS * 1.5) / (BASE_RADIUS * 3));
        
        projected.push({
          x: x2d,
          y: y2d,
          z: z3d,
          size: p.size * scale * (1 + audio.overall * (0.28 + reactivityFactor * 0.2)),
          opacity: p.opacity * depthOpacity * (0.62 + audio.overall * 0.38) * dimFactor,
        });
      }

      // Sort back-to-front
      projected.sort((a, b) => a.z - b.z);

      // Draw particles
      for (const p of projected) {
        const depthHueShift = (p.z / (BASE_RADIUS * 1.8)) * 24;
        const shimmerHueShift = Math.sin(t * 1.4 + p.x * 0.025 + p.y * 0.02) * 6;
        const particleHue = (dynamicBaseHue + depthHueShift + shimmerHueShift + 360) % 360;
        const particleLightness = clamp(lightness + (p.z / (BASE_RADIUS * 2.2)) * 8, 55, 96);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${particleHue}, ${saturation}%, ${particleLightness}%, ${p.opacity})`;
        ctx.fill();
      }

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frameRef.current);
    };
  }, [getAudioLevel]);

  return (
    <div className="relative flex items-center justify-center">
      <canvas
        ref={canvasRef}
        style={{ width: RENDERED_SIZE, height: RENDERED_SIZE }}
        className="pointer-events-none"
      />
    </div>
  );
};

export default Orb;
