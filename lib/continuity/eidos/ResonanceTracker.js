/**
 * Resonance Tracker
 *
 * Computes relational health metrics from synthesis results.
 * Tracks anchor/shorthand creation rates, emotional range,
 * and attunement ratio to detect warming/cooling relationships.
 *
 * Pure computation - no Redis/Mongo calls. The caller stores the result.
 */

export class ResonanceTracker {
    /**
     * @param {Object} [options]
     * @param {number} [options.emaAlpha=0.3] - Exponential moving average smoothing factor
     */
    constructor(options = {}) {
        this.emaAlpha = options.emaAlpha || 0.3;
    }

    /**
     * Compute relational health metrics from a synthesis result.
     *
     * @param {Object} synthesisResult - Result from NarrativeSynthesizer.synthesizeTurn()
     * @param {Array} synthesisResult.newAnchors
     * @param {Array} synthesisResult.newArtifacts
     * @param {Array} synthesisResult.identityUpdates
     * @param {Array} synthesisResult.shorthands
     * @param {Object|null} existingMetrics - Previous metrics to blend with (null for first computation)
     * @returns {{ anchorRate: number, shorthandRate: number, emotionalRange: number, attunementRatio: number, trend: string }}
     */
    computeMetrics(synthesisResult, existingMetrics = null) {
        if (!synthesisResult) {
            return existingMetrics || this._defaultMetrics();
        }

        const newAnchors = synthesisResult.newAnchors?.length || 0;
        const newArtifacts = synthesisResult.newArtifacts?.length || 0;
        const newShorthands = synthesisResult.shorthands?.length || 0;
        const identityUpdates = synthesisResult.identityUpdates?.length || 0;

        // Current turn rates
        const anchorRate = newAnchors;
        const shorthandRate = newShorthands;

        // Emotional range: count unique valences in new memories
        const valences = new Set();
        for (const mem of [...(synthesisResult.newAnchors || []), ...(synthesisResult.identityUpdates || [])]) {
            if (mem.emotionalState?.valence) {
                valences.add(mem.emotionalState.valence);
            }
        }
        // Normalize to 0-1 (assume max ~8 distinct valences in a turn is very diverse)
        const emotionalRange = Math.min(1.0, valences.size / 8);

        // Attunement ratio: relational memories (anchors + shorthands) vs technical (artifacts)
        const relational = newAnchors + newShorthands;
        const total = relational + newArtifacts + identityUpdates;
        const attunementRatio = total > 0 ? relational / total : 0.5;

        // Build current metrics
        const current = {
            anchorRate,
            shorthandRate,
            emotionalRange,
            attunementRatio,
            trend: 'unknown',
        };

        // Blend with existing using EMA
        if (existingMetrics) {
            const blended = this._blend(current, existingMetrics);
            blended.trend = this._detectTrend(blended, existingMetrics);
            return blended;
        }

        return current;
    }

    /**
     * Blend current metrics with existing using exponential moving average
     * @private
     */
    _blend(current, existing) {
        const alpha = this.emaAlpha;
        return {
            anchorRate: this._ema(current.anchorRate, existing.anchorRate, alpha),
            shorthandRate: this._ema(current.shorthandRate, existing.shorthandRate, alpha),
            emotionalRange: this._ema(current.emotionalRange, existing.emotionalRange, alpha),
            attunementRatio: this._ema(current.attunementRatio, existing.attunementRatio, alpha),
            trend: 'unknown',
        };
    }

    /**
     * Exponential moving average
     * @private
     */
    _ema(current, previous, alpha) {
        if (previous === undefined || previous === null) return current;
        return Math.round((alpha * current + (1 - alpha) * previous) * 1000) / 1000;
    }

    /**
     * Detect relationship trend from blended metrics
     * @private
     */
    _detectTrend(blended, previous) {
        const anchorDelta = blended.anchorRate - (previous.anchorRate || 0);
        const shorthandDelta = blended.shorthandRate - (previous.shorthandRate || 0);
        const attunementDelta = blended.attunementRatio - (previous.attunementRatio || 0.5);

        const warmingSignals = (anchorDelta > 0.1 ? 1 : 0)
            + (shorthandDelta > 0.05 ? 1 : 0)
            + (attunementDelta > 0.05 ? 1 : 0);

        const coolingSignals = (anchorDelta < -0.1 ? 1 : 0)
            + (shorthandDelta < -0.05 ? 1 : 0)
            + (attunementDelta < -0.05 ? 1 : 0);

        if (warmingSignals >= 2) return 'warming';
        if (coolingSignals >= 2) return 'cooling';
        return 'stable';
    }

    /**
     * @private
     */
    _defaultMetrics() {
        return {
            anchorRate: 0,
            shorthandRate: 0,
            emotionalRange: 0,
            attunementRatio: 0.5,
            trend: 'unknown',
        };
    }
}
