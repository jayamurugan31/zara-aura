import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { AudioData } from "@/hooks/useAudioAnalysis";

type OrbState = "idle" | "listening" | "thinking" | "speaking" | "processing";
type Emotion = "neutral" | "happy" | "angry" | "calm" | "curious";

interface ParticleOrbProps {
  state: OrbState;
  audioData: AudioData;
  emotion: Emotion;
  mousePos: { x: number; y: number };
}

const PARTICLE_COUNT = 2000;

const emotionColors: Record<Emotion, [THREE.Color, THREE.Color]> = {
  neutral: [new THREE.Color(0x00d4ff), new THREE.Color(0x0088cc)],
  happy: [new THREE.Color(0x00e5ff), new THREE.Color(0x80d8ff)],
  angry: [new THREE.Color(0xff4444), new THREE.Color(0xff8800)],
  calm: [new THREE.Color(0x8844ff), new THREE.Color(0x4400aa)],
  curious: [new THREE.Color(0xffffff), new THREE.Color(0xffee00)],
};

// Vertex shader for particle positions and sizes
const vertexShader = `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uVolume;
  uniform float uPitch;
  uniform float uStateInfluence;
  uniform float uRotation;
  uniform float uExpansion;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vColor;
  varying float vAlpha;

  // Simplex-like noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x4 = x_ * ns.x + ns.yyyy;
    vec4 y4 = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x4) - abs(y4);
    vec4 b0 = vec4(x4.xy, y4.xy);
    vec4 b1 = vec4(x4.zw, y4.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vec3 pos = position;
    float r = length(pos);
    float theta = atan(pos.y, pos.x);
    float phi = acos(pos.z / max(r, 0.001));

    // Noise displacement
    float noiseScale = 0.8 + uVolume * 0.6;
    float timeScale = uTime * (0.3 + uPitch * 0.5) * aSpeed;
    float noise = snoise(pos * noiseScale + timeScale);

    // Expansion based on volume and state
    float expansion = 1.0 + uVolume * 0.3 + uExpansion;

    // Radial displacement
    float displacement = noise * (0.1 + uVolume * 0.25) * uStateInfluence;
    pos = pos * expansion + normalize(pos) * displacement;

    // Rotation for thinking state
    float cosR = cos(uRotation);
    float sinR = sin(uRotation);
    mat3 rotY = mat3(cosR, 0.0, sinR, 0.0, 1.0, 0.0, -sinR, 0.0, cosR);
    pos = rotY * pos;

    // Color based on position and phase
    float colorMix = 0.5 + 0.5 * sin(aPhase + uTime * 0.5);
    vColor = mix(uColorA, uColorB, colorMix);
    vAlpha = 0.4 + 0.6 * (0.5 + 0.5 * noise) * (0.5 + uVolume * 0.5);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = aSize * (1.0 + uVolume * 1.5) * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = vAlpha * smoothstep(0.5, 0.1, dist);
    gl_FragColor = vec4(vColor, alpha);
  }
`;

function Particles({ state, audioData, emotion, mousePos }: ParticleOrbProps) {
  const meshRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const targetColorA = useRef(new THREE.Color(0x00d4ff));
  const targetColorB = useRef(new THREE.Color(0x0088cc));
  const currentColorA = useRef(new THREE.Color(0x00d4ff));
  const currentColorB = useRef(new THREE.Color(0x0088cc));

  const { positions, phases, speeds, sizes } = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const phases = new Float32Array(PARTICLE_COUNT);
    const speeds = new Float32Array(PARTICLE_COUNT);
    const sizes = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Fibonacci sphere distribution
      const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const theta = goldenAngle * i;

      const radius = 1.5 + (Math.random() - 0.5) * 0.3;
      positions[i * 3] = Math.cos(theta) * radiusAtY * radius;
      positions[i * 3 + 1] = y * radius;
      positions[i * 3 + 2] = Math.sin(theta) * radiusAtY * radius;

      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 0.5 + Math.random() * 1.0;
      sizes[i] = 1.0 + Math.random() * 2.0;
    }
    return { positions, phases, speeds, sizes };
  }, []);

  // Update target colors on emotion change
  useEffect(() => {
    const [a, b] = emotionColors[emotion];
    targetColorA.current.copy(a);
    targetColorB.current.copy(b);
  }, [emotion]);

  useFrame(({ clock }) => {
    const mat = materialRef.current;
    if (!mat) return;

    const t = clock.getElapsedTime();

    // Smooth color interpolation
    currentColorA.current.lerp(targetColorA.current, 0.03);
    currentColorB.current.lerp(targetColorB.current, 0.03);

    mat.uniforms.uTime.value = t;
    mat.uniforms.uVolume.value = THREE.MathUtils.lerp(mat.uniforms.uVolume.value, audioData.volume, 0.15);
    mat.uniforms.uPitch.value = THREE.MathUtils.lerp(mat.uniforms.uPitch.value, audioData.pitch, 0.1);
    mat.uniforms.uColorA.value.copy(currentColorA.current);
    mat.uniforms.uColorB.value.copy(currentColorB.current);

    // State-specific behavior
    let stateInfluence = 1.0;
    let rotation = 0;
    let expansion = 0;

    switch (state) {
      case "idle":
        stateInfluence = 0.5;
        break;
      case "listening":
        stateInfluence = 1.5;
        expansion = 0.15;
        break;
      case "thinking":
        stateInfluence = 0.8;
        rotation = t * 0.3;
        break;
      case "speaking":
        stateInfluence = 1.2 + Math.sin(t * 4) * 0.3;
        break;
      case "processing":
        stateInfluence = 0.6;
        rotation = t * 0.5;
        expansion = -0.1;
        break;
    }

    mat.uniforms.uStateInfluence.value = THREE.MathUtils.lerp(mat.uniforms.uStateInfluence.value, stateInfluence, 0.05);
    mat.uniforms.uRotation.value = THREE.MathUtils.lerp(mat.uniforms.uRotation.value, rotation, 0.05);
    mat.uniforms.uExpansion.value = THREE.MathUtils.lerp(mat.uniforms.uExpansion.value, expansion, 0.05);

    // Mouse parallax
    if (meshRef.current) {
      meshRef.current.rotation.y = THREE.MathUtils.lerp(meshRef.current.rotation.y, mousePos.x * 0.15, 0.03);
      meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, -mousePos.y * 0.1, 0.03);
    }
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aPhase" args={[phases, 1]} />
        <bufferAttribute attach="attributes-aSpeed" args={[speeds, 1]} />
        <bufferAttribute attach="attributes-aSize" args={[sizes, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={{
          uTime: { value: 0 },
          uVolume: { value: 0 },
          uPitch: { value: 0.5 },
          uStateInfluence: { value: 0.5 },
          uRotation: { value: 0 },
          uExpansion: { value: 0 },
          uColorA: { value: new THREE.Color(0x00d4ff) },
          uColorB: { value: new THREE.Color(0x0088cc) },
        }}
      />
    </points>
  );
}

// Inner glow sphere
function CoreGlow({ audioData, emotion }: { audioData: AudioData; emotion: Emotion }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const targetColor = useRef(new THREE.Color(0x00d4ff));

  useEffect(() => {
    targetColor.current.copy(emotionColors[emotion][0]);
  }, [emotion]);

  useFrame(() => {
    if (meshRef.current && matRef.current) {
      const s = 0.6 + audioData.volume * 0.3;
      meshRef.current.scale.setScalar(THREE.MathUtils.lerp(meshRef.current.scale.x, s, 0.1));
      matRef.current.color.lerp(targetColor.current, 0.03);
      matRef.current.opacity = THREE.MathUtils.lerp(matRef.current.opacity, 0.08 + audioData.volume * 0.12, 0.1);
    }
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 32, 32]} />
      <meshBasicMaterial ref={matRef} color={0x00d4ff} transparent opacity={0.08} />
    </mesh>
  );
}

export default function ParticleOrb(props: ParticleOrbProps) {
  return (
    <div className="w-[400px] h-[400px]">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        gl={{ alpha: true, antialias: true }}
        style={{ background: "transparent" }}
      >
        <Particles {...props} />
        <CoreGlow audioData={props.audioData} emotion={props.emotion} />
      </Canvas>
    </div>
  );
}
