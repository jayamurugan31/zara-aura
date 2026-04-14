import type { ResponseMode } from "@/lib/settings";

export type BackendEmotion = "happy" | "angry" | "calm" | "neutral";

export interface BackendAudioFeatures {
  volume: number;
  pitch: number;
}

export interface BackendAction {
  [key: string]: string | number | boolean | null;
}

export interface ChatApiResponse {
  text: string;
  language: string;
  emotion: BackendEmotion;
  audio_features: BackendAudioFeatures;
  action: BackendAction | null;
}

export interface VoiceApiResponse extends ChatApiResponse {
  transcript: string;
}

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL || "http://localhost:8000").replace(/\/$/, "");

function endpoint(path: string): string {
  return `${BACKEND_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload?.detail) {
      return payload.detail;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || "Request failed";
}

async function requestJson<T>(urlPath: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(endpoint(urlPath), init);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Unable to reach backend");
  }

  if (!response.ok) {
    const message = await parseError(response);
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function requestBlob(urlPath: string, init: RequestInit): Promise<Blob> {
  let response: Response;

  try {
    response = await fetch(endpoint(urlPath), init);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Unable to reach backend");
  }

  if (!response.ok) {
    const message = await parseError(response);
    throw new Error(message);
  }

  return response.blob();
}

export async function syncBackendMode(mode: ResponseMode): Promise<void> {
  await requestJson<{ mode: ResponseMode }>("/mode", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode }),
  });
}

export async function syncBackendFlightMode(enabled: boolean): Promise<void> {
  await requestJson<{ enabled: boolean }>("/flight-mode", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
}

export async function sendVoiceChunk(
  audioChunk: Blob,
  mode: ResponseMode,
  preferredLanguage?: string,
): Promise<VoiceApiResponse> {
  const formData = new FormData();
  formData.append("file", audioChunk, `zara-voice-${Date.now()}.webm`);
  formData.append("mode", mode);
  formData.append("synthesize", "false");
  if (preferredLanguage) {
    formData.append("preferred_language", preferredLanguage);
  }

  return requestJson<VoiceApiResponse>("/voice", {
    method: "POST",
    body: formData,
  });
}

export async function sendChatMessage(
  text: string,
  mode: ResponseMode,
  volume = 0,
  preferredLanguage?: string,
): Promise<ChatApiResponse> {
  return requestJson<ChatApiResponse>("/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      mode,
      volume,
      preferred_language: preferredLanguage,
      synthesize: false,
    }),
  });
}

export async function fetchTtsAudio(text: string, language?: string): Promise<Blob> {
  return requestBlob("/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      language,
    }),
  });
}
