import { useRef, useState, useCallback, useEffect } from "react";

export interface AudioData {
  volume: number;      // 0-1 normalized amplitude
  pitch: number;       // 0-1 normalized frequency  
  bassEnergy: number;  // 0-1 low frequency energy
  trebleEnergy: number; // 0-1 high frequency energy
}

const defaultAudioData: AudioData = {
  volume: 0,
  pitch: 0.5,
  bassEnergy: 0,
  trebleEnergy: 0,
};

export function useAudioAnalysis() {
  const [audioData, setAudioData] = useState<AudioData>(defaultAudioData);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    // Volume (RMS of all frequencies)
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) sum += dataArray[i] * dataArray[i];
    const volume = Math.min(Math.sqrt(sum / bufferLength) / 128, 1);

    // Bass energy (first 1/6 of spectrum)
    const bassEnd = Math.floor(bufferLength / 6);
    let bassSum = 0;
    for (let i = 0; i < bassEnd; i++) bassSum += dataArray[i];
    const bassEnergy = Math.min(bassSum / (bassEnd * 255), 1);

    // Treble energy (last 1/3 of spectrum)
    const trebleStart = Math.floor(bufferLength * 2 / 3);
    let trebleSum = 0;
    for (let i = trebleStart; i < bufferLength; i++) trebleSum += dataArray[i];
    const trebleEnergy = Math.min(trebleSum / ((bufferLength - trebleStart) * 255), 1);

    // Pitch (spectral centroid normalized)
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < bufferLength; i++) {
      weightedSum += i * dataArray[i];
      totalWeight += dataArray[i];
    }
    const pitch = totalWeight > 0 ? Math.min(weightedSum / (totalWeight * bufferLength), 1) : 0.5;

    setAudioData({ volume, pitch, bassEnergy, trebleEnergy });
    rafRef.current = requestAnimationFrame(analyze);
  }, []);

  const startAnalysis = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      contextRef.current = context;
      analyserRef.current = analyser;
      streamRef.current = stream;
      setIsAnalyzing(true);
      rafRef.current = requestAnimationFrame(analyze);
    } catch (e) {
      console.error("Mic access denied:", e);
    }
  }, [analyze]);

  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    contextRef.current?.close();
    contextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setIsAnalyzing(false);
    setAudioData(defaultAudioData);
  }, []);

  useEffect(() => () => { stopAnalysis(); }, [stopAnalysis]);

  return { audioData, isAnalyzing, startAnalysis, stopAnalysis };
}
