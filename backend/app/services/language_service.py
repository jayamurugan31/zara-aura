from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from langdetect import DetectorFactory, LangDetectException, detect_langs


DetectorFactory.seed = 0


_SUPPORTED_LANGUAGE_CODES: set[str] = {
    "en",
    "hi",
    "ta",
    "te",
    "ml",
}


_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "hi": "Hindi",
    "ml": "Malayalam",
    "ta": "Tamil",
    "te": "Telugu",
}


_SCRIPT_BUCKETS: dict[str, tuple[tuple[int, int], ...]] = {
    "deva": ((0x0900, 0x097F),),  # Hindi Devanagari
    "ta": ((0x0B80, 0x0BFF),),
    "te": ((0x0C00, 0x0C7F),),
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
        "thira",
        "thirakka",
        "pannu",
        "niruthu",
        "venum",
        "inga",
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
        "chey",
        "cheyyi",
        "aapu",
        "ippudu",
        "kavali",
        "vinali",
    ),
    "ml": (
        "namaskaram",
        "sughamano",
        "njan",
        "ningal",
        "enthaanu",
        "cheyyu",
        "nirthu",
        "venam",
        "thudangu",
        "kelkku",
        "ennu",
    ),
    "hi": (
        "namaste",
        "kaise",
        "aap",
        "mujhe",
        "kya",
        "karo",
        "chalu",
        "band",
        "suno",
        "kripya",
    ),
}


_DEVANAGARI_HINTS: dict[str, tuple[str, ...]] = {
    "hi": ("है", "क्या", "आप", "मैं", "और", "करो", "चालू", "बंद", "सुनो"),
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
        script_char_count = self._count_script_chars(normalized, script_code) if script_code else 0
        if script_code and (script_ratio >= 0.22 or script_char_count >= 3):
            if script_code == "deva":
                script_code = self._resolve_devanagari_language(normalized)
            if script_code in _SUPPORTED_LANGUAGE_CODES:
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
        supported_scores: dict[str, float] = defaultdict(float)
        for code, score in scores.items():
            normalized_code = self._normalize_code(code)
            if normalized_code in _SUPPORTED_LANGUAGE_CODES:
                supported_scores[normalized_code] += score

        if not supported_scores:
            return "en", 0.0

        best_code, best_score = max(supported_scores.items(), key=lambda item: item[1])
        clamped = max(0.0, min(1.0, best_score))
        return best_code, clamped

    def _build_result(self, code: str, confidence: float) -> LanguageDetectionResult:
        normalized_code = self._normalize_code(code)
        if normalized_code not in _SUPPORTED_LANGUAGE_CODES:
            return self._fallback()
        name = _LANGUAGE_NAMES.get(normalized_code, normalized_code)
        clamped_confidence = max(0.0, min(1.0, confidence))
        return LanguageDetectionResult(code=normalized_code, name=name, confidence=clamped_confidence)

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

    def _count_script_chars(self, text: str, script_code: str) -> int:
        ranges = _SCRIPT_BUCKETS.get(script_code)
        if not ranges:
            return 0

        count = 0
        for char in text:
            if not char.isalpha():
                continue

            code_point = ord(char)
            if any(start <= code_point <= end for start, end in ranges):
                count += 1

        return count

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
            "en-us": "en",
            "en-gb": "en",
            "gom": "hi",
            "mai": "hi",
            "bho": "hi",
        }
        return aliases.get(lowered, lowered)

    def _fallback(self) -> LanguageDetectionResult:
        return LanguageDetectionResult(code="en", name="English", confidence=0.0)
