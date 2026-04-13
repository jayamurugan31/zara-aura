from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from langdetect import DetectorFactory, LangDetectException, detect_langs


DetectorFactory.seed = 0


_LANGUAGE_NAMES: dict[str, str] = {
    "as": "Assamese",
    "ar": "Arabic",
    "bn": "Bengali",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fa": "Persian",
    "fi": "Finnish",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "kn": "Kannada",
    "ko": "Korean",
    "ml": "Malayalam",
    "mr": "Marathi",
    "ne": "Nepali",
    "nl": "Dutch",
    "no": "Norwegian",
    "or": "Odia",
    "pa": "Punjabi",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sv": "Swedish",
    "ta": "Tamil",
    "te": "Telugu",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "vi": "Vietnamese",
    "zh": "Chinese",
}


_SCRIPT_BUCKETS: dict[str, tuple[tuple[int, int], ...]] = {
    "deva": ((0x0900, 0x097F),),  # Hindi/Marathi/Nepali and related Devanagari languages
    "bn": ((0x0980, 0x09FF),),
    "pa": ((0x0A00, 0x0A7F),),
    "gu": ((0x0A80, 0x0AFF),),
    "or": ((0x0B00, 0x0B7F),),
    "ta": ((0x0B80, 0x0BFF),),
    "te": ((0x0C00, 0x0C7F),),
    "kn": ((0x0C80, 0x0CFF),),
    "ml": ((0x0D00, 0x0D7F),),
}


_TRANSLIT_HINTS: dict[str, tuple[str, ...]] = {
    "ta": (
        "vanakkam",
        "nandri",
        "naan",
        "ungal",
        "epadi",
        "irukk",
        "irukken",
        "saptiya",
    ),
    "te": (
        "namaskaram",
        "meeru",
        "nenu",
        "ela",
        "unnaru",
        "ela unnaru",
        "bagunn",
        "avuna",
    ),
    "kn": (
        "namaskara",
        "hegiddira",
        "nanu",
        "neevu",
        "chennagide",
    ),
    "ml": (
        "namaskaram",
        "sughamano",
        "njan",
        "ningal",
        "enthaanu",
    ),
    "hi": (
        "namaste",
        "kaise",
        "aap",
        "mujhe",
        "kya",
    ),
    "mr": (
        "namaskar",
        "tumhi",
        "kasa",
        "ahe",
        "majha",
    ),
    "bn": (
        "nomoskar",
        "kemon",
        "ami",
        "tumi",
    ),
    "gu": (
        "kem cho",
        "majama",
        "shu",
    ),
    "pa": (
        "sat sri akal",
        "tusi",
    ),
}


_DEVANAGARI_HINTS: dict[str, tuple[str, ...]] = {
    "mr": ("आहे", "तुम्ही", "काय", "मला", "आणि"),
    "ne": ("तपाईं", "छ", "हुन्छ", "हो", "र"),
    "hi": ("है", "क्या", "आप", "मैं", "और"),
}


@dataclass(slots=True)
class LanguageDetectionResult:
    code: str
    name: str
    confidence: float


class LanguageService:
    """Language detection helper for multilingual response control."""

    def detect(self, text: str) -> LanguageDetectionResult:
        normalized = self._normalize_text(text)
        if len(normalized) < 2:
            return self._fallback()

        script_code, script_ratio = self._detect_script_hint(normalized)
        if script_code and script_ratio >= 0.72:
            if script_code == "deva":
                script_code = self._resolve_devanagari_language(normalized)
            return self._build_result(script_code, min(0.99, 0.65 + script_ratio / 2.0))

        score_board: dict[str, float] = defaultdict(float)

        if script_code:
            boosted_script_code = script_code if script_code != "deva" else self._resolve_devanagari_language(normalized)
            score_board[boosted_script_code] += 0.28 + (script_ratio * 0.35)

        translit_code, translit_hits = self._detect_transliteration_hint(normalized)

        if translit_code and translit_hits >= 2 and self._is_mostly_latin(normalized):
            confidence = min(0.95, 0.56 + (0.14 * translit_hits))
            return self._build_result(translit_code, confidence)

        if translit_code:
            score_board[translit_code] += min(0.65, 0.2 + (0.12 * translit_hits))

        try:
            candidates = detect_langs(normalized)
        except LangDetectException:
            if score_board:
                code, confidence = self._pick_best(score_board)
                return self._build_result(code, confidence)
            return self._fallback()

        for candidate in candidates:
            code = self._normalize_code(candidate.lang)
            score_board[code] += float(candidate.prob)

        if not score_board:
            return self._fallback()

        code, confidence = self._pick_best(score_board)
        return self._build_result(code, confidence)

    def _pick_best(self, scores: dict[str, float]) -> tuple[str, float]:
        best_code, best_score = max(scores.items(), key=lambda item: item[1])
        clamped = max(0.0, min(1.0, best_score))
        return best_code, clamped

    def _build_result(self, code: str, confidence: float) -> LanguageDetectionResult:
        normalized_code = self._normalize_code(code)
        name = _LANGUAGE_NAMES.get(normalized_code, normalized_code)
        return LanguageDetectionResult(code=normalized_code, name=name, confidence=confidence)

    def _detect_script_hint(self, text: str) -> tuple[str | None, float]:
        total_letters = 0
        script_counts: dict[str, int] = defaultdict(int)

        for char in text:
            if not char.isalpha():
                continue

            total_letters += 1
            code_point = ord(char)

            for script_code, ranges in _SCRIPT_BUCKETS.items():
                if any(start <= code_point <= end for start, end in ranges):
                    script_counts[script_code] += 1
                    break

        if total_letters == 0 or not script_counts:
            return None, 0.0

        best_script, count = max(script_counts.items(), key=lambda item: item[1])
        return best_script, count / total_letters

    def _detect_transliteration_hint(self, text: str) -> tuple[str | None, int]:
        lowered = text.lower()
        hints: dict[str, int] = defaultdict(int)

        for code, tokens in _TRANSLIT_HINTS.items():
            for token in tokens:
                if token in lowered:
                    hints[code] += 1

        if not hints:
            return None, 0

        best_code, best_count = max(hints.items(), key=lambda item: item[1])
        if best_count <= 0:
            return None, 0
        return best_code, best_count

    def _is_mostly_latin(self, text: str) -> bool:
        alpha_chars = [char for char in text if char.isalpha()]
        if not alpha_chars:
            return False

        latin_count = 0
        for char in alpha_chars:
            code_point = ord(char)
            if (0x0041 <= code_point <= 0x005A) or (0x0061 <= code_point <= 0x007A):
                latin_count += 1

        return (latin_count / len(alpha_chars)) >= 0.75

    def _resolve_devanagari_language(self, text: str) -> str:
        hint_scores: dict[str, int] = defaultdict(int)

        for code, tokens in _DEVANAGARI_HINTS.items():
            for token in tokens:
                if token in text:
                    hint_scores[code] += 1

        if hint_scores:
            best_code, best_count = max(hint_scores.items(), key=lambda item: item[1])
            if best_count > 0:
                return best_code

        return "hi"

    def _normalize_text(self, text: str) -> str:
        squashed = " ".join(text.strip().split())
        return "".join(char for char in squashed if char.isalpha() or char.isspace())

    def _normalize_code(self, code: str) -> str:
        lowered = code.strip().lower()
        aliases = {
            "zh-cn": "zh",
            "zh-tw": "zh",
            "pt-br": "pt",
            "pt-pt": "pt",
            "en-us": "en",
            "en-gb": "en",
            "ori": "or",
            "od": "or",
            "gom": "hi",
            "mai": "hi",
        }
        return aliases.get(lowered, lowered)

    def _fallback(self) -> LanguageDetectionResult:
        return LanguageDetectionResult(code="en", name="English", confidence=0.0)
