from __future__ import annotations

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from app.schemas import EmotionLiteral


class EmotionService:
    """Lightweight sentiment + volume based emotion mapping."""

    def __init__(self) -> None:
        self.analyzer = SentimentIntensityAnalyzer()

    def detect(self, text: str, volume: float) -> EmotionLiteral:
        if not text.strip():
            return "neutral"

        score = self.analyzer.polarity_scores(text).get("compound", 0.0)

        if score >= 0.45 and volume >= 0.35:
            return "happy"

        if score <= -0.45 and volume >= 0.45:
            return "angry"

        if abs(score) < 0.2 and volume <= 0.32:
            return "calm"

        if score > 0.25 and volume <= 0.40:
            return "calm"

        return "neutral"
