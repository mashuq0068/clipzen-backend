/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
/**
 * clipSelector.js
 *
 * Key changes vs previous version:
 *  1. User-requested clip count is always honoured exactly — no smart-capping.
 *  2. Layout stability data (from speakerReframer) is fed into clip scoring and
 *     boundary trimming so clips with constant layout-switching are either
 *     trimmed to stable windows or penalised in ranking.
 *  3. buildStoryClips now receives layoutMap so storyEngine can also penalise
 *     unstable blocks internally.
 */

const { buildStoryClips, buildStoryClipsSync } = require("./storyEngine");
const {
  endsSentence,
  isQuestion,
  firstSentenceSummary,
} = require("../utils/textLang");

const PLATFORM_LIMITS = {
  tiktok:    { sweet: { min: 15, max: 90  } },
  instagram: { sweet: { min: 15, max: 90  } },
  youtube:   { sweet: { min: 15, max: 60  } },
  facebook:  { sweet: { min: 15, max: 60  } },
  twitter:   { sweet: { min: 15, max: 60  } },
  linkedin:  { sweet: { min: 30, max: 180 } },
};

// ─────────────────────────────────────────────────────────────
// PLATFORM DURATION
// ─────────────────────────────────────────────────────────────
function getPlatformDuration(platforms, clipDurationSetting) {
  if (clipDurationSetting !== "auto") {
    const secs = parseInt(clipDurationSetting.replace("s", ""), 10);
    return { ideal: secs, min: Math.max(5, secs - 10), max: secs + 15 };
  }
  const active = (platforms || []).filter((p) => PLATFORM_LIMITS[p]);
  if (!active.length) return { ideal: 45, min: 15, max: 90 };
  const mins = active.map((p) => PLATFORM_LIMITS[p].sweet.min);
  const maxs = active.map((p) => PLATFORM_LIMITS[p].sweet.max);
  const globalMin = Math.max(...mins);
  const globalMax = Math.min(...maxs);
  return {
    ideal: Math.max(15, Math.round((globalMin + globalMax) / 2)),
    min:   Math.max(5, globalMin),
    max:   Math.max(30, globalMax),
  };
}

// ─────────────────────────────────────────────────────────────
// LAYOUT STABILITY HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * layoutMap: sparse array indexed by integer second.
 * layoutMap[sec] = "face" | "split" | "blur_overlay" | "passthrough" | undefined
 *
 * Built from speakerReframer timeline entries before clip selection begins.
 * If no layout analysis was run, layoutMap is an empty object and all helpers
 * below gracefully return "stable" scores so nothing breaks.
 */

/**
 * Count layout-mode transitions per second inside [startSec, endSec].
 * Returns a value 0..1 where 0 = perfectly stable, 1 = constant switching.
 */
function layoutInstabilityScore(layoutMap, startSec, endSec) {
  if (!layoutMap || Object.keys(layoutMap).length === 0) return 0;

  const samples = [];
  for (let t = Math.floor(startSec); t <= Math.ceil(endSec); t++) {
    const mode = layoutMap[t];
    if (mode) samples.push(mode);
  }
  if (samples.length < 2) return 0;

  let transitions = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] !== samples[i - 1]) transitions++;
  }
  return transitions / (samples.length - 1); // 0 = stable, 1 = every second changes
}

/**
 * Dominant layout mode across [startSec, endSec].
 * Returns { mode, fraction } where fraction is 0..1.
 */
function dominantLayout(layoutMap, startSec, endSec) {
  if (!layoutMap || Object.keys(layoutMap).length === 0) {
    return { mode: "unknown", fraction: 0 };
  }
  const counts = {};
  let total = 0;
  for (let t = Math.floor(startSec); t <= Math.ceil(endSec); t++) {
    const mode = layoutMap[t];
    if (mode) {
      counts[mode] = (counts[mode] || 0) + 1;
      total++;
    }
  }
  if (total === 0) return { mode: "unknown", fraction: 0 };
  const [mode, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { mode, fraction: count / total };
}

/**
 * Find the largest contiguous window inside [startSec, endSec] that has a
 * stable layout (instability score below threshold).
 *
 * Strategy:
 *  - Slide a window of at least minWindowSecs through the range.
 *  - Pick the window whose dominant mode fraction is highest AND whose
 *    instability score is below STABLE_THRESHOLD.
 *  - If no window meets the threshold, return the original range unchanged
 *    (let the clip through; it will be downscored instead).
 *
 * Returns { newStart, newEnd, wasTrimed, instability, dominant }
 */
const STABLE_THRESHOLD   = 0.25;  // max instability score to keep a window
const MIN_STABLE_WINDOW  = 20;    // seconds — never trim below this
const TRIM_STEP          = 1;     // seconds — trim granularity

function findStableWindow(layoutMap, startSec, endSec, minWindowSecs = MIN_STABLE_WINDOW) {
  const originalInstability = layoutInstabilityScore(layoutMap, startSec, endSec);
  const dom = dominantLayout(layoutMap, startSec, endSec);

  if (originalInstability <= STABLE_THRESHOLD) {
    return {
      newStart:    startSec,
      newEnd:      endSec,
      wasTrimmed:  false,
      instability: originalInstability,
      dominant:    dom,
    };
  }

  const totalDur = endSec - startSec;
  if (totalDur <= minWindowSecs) {
    // Too short to trim further — return as-is, it will be penalised in scoring
    return {
      newStart:    startSec,
      newEnd:      endSec,
      wasTrimmed:  false,
      instability: originalInstability,
      dominant:    dom,
    };
  }

  let bestStart  = startSec;
  let bestEnd    = endSec;
  let bestScore  = -1;  // higher = better (stable + long)

  const minWin = Math.max(minWindowSecs, Math.round(totalDur * 0.4));

  for (let s = startSec; s <= endSec - minWin; s += TRIM_STEP) {
    for (let e = s + minWin; e <= endSec; e += TRIM_STEP) {
      const instab = layoutInstabilityScore(layoutMap, s, e);
      if (instab > STABLE_THRESHOLD) continue;
      const { fraction } = dominantLayout(layoutMap, s, e);
      // Reward long stable windows with a high dominant fraction
      const score = (e - s) * fraction * (1 - instab);
      if (score > bestScore) {
        bestScore  = score;
        bestStart  = s;
        bestEnd    = e;
      }
    }
  }

  if (bestScore < 0) {
    // Nothing passed the threshold — return original, flag as unstable
    return {
      newStart:    startSec,
      newEnd:      endSec,
      wasTrimmed:  false,
      instability: originalInstability,
      dominant:    dom,
    };
  }

  return {
    newStart:    bestStart,
    newEnd:      bestEnd,
    wasTrimmed:  bestStart > startSec + 0.5 || bestEnd < endSec - 0.5,
    instability: layoutInstabilityScore(layoutMap, bestStart, bestEnd),
    dominant:    dominantLayout(layoutMap, bestStart, bestEnd),
  };
}

// ─────────────────────────────────────────────────────────────
// RULE-BASED FALLBACK (kept for when story engine fails)
// ─────────────────────────────────────────────────────────────
const HOOK_KEYWORDS = [
  "secret", "trick", "hack", "mistake", "truth", "never", "always",
  "important", "change", "don't", "stop", "why", "how to", "most people",
  "you need", "i learned", "biggest", "incredible", "amazing", "shocking",
  "surprising", "finally", "actually", "tip", "key", "critical",
];

function findCleanEnd(segments, rawEndSec) {
  const nearby = segments.filter(
    (s) => s.end >= rawEndSec - 5 && s.end <= rawEndSec + 20
  );
  // Multilingual: snap to a real sentence end in any script (., 。, ।, ؟, …).
  const clean = nearby.find((s) => endsSentence(s.text));
  return clean ? clean.end : nearby[0]?.end || rawEndSec;
}

function findCleanStart(segments, rawStartSec) {
  const nearby = segments.filter(
    (s) => s.start >= rawStartSec - 5 && s.start <= rawStartSec + 5
  );
  return nearby[0]?.start ?? rawStartSec;
}

function selectWithRules(segments, clipCount, clipDuration, platforms, layoutMap) {
  if (!segments || !segments.length) return [];

  const totalSecs = segments[segments.length - 1]?.end || 0;
  const duration  = getPlatformDuration(platforms, clipDuration);

  // Adaptive ideal duration: if video is short relative to clipCount,
  // shrink the window so we can produce distinct clips without running out of content.
  const rawIdeal  = duration.ideal;
  const adaptedIdeal = Math.max(
    10, // absolute minimum window
    Math.min(rawIdeal, Math.floor(totalSecs / clipCount) + 5)
  );
  const idealDur = adaptedIdeal;

  const scored = segments.map((seg, i) => {
    const rawText   = seg.text || "";
    const text      = rawText.toLowerCase();
    // English keyword hooks — a BONUS when present (never required).
    const kwScore   = HOOK_KEYWORDS.reduce(
      (sum, kw) => sum + (text.includes(kw) ? 8 : 0), 0
    );
    // Language-NEUTRAL hook signals — these work in every language:
    const qScore    = isQuestion(rawText) ? 10 : 0;        // questions pull viewers in
    const numScore  = /\p{N}/u.test(rawText) ? 5 : 0;      // concrete numbers / stats
    const wc        = rawText.trim().split(/\s+/).filter(Boolean).length;
    const lenScore  = wc >= 8 && wc <= 60 ? 6 : 0;         // substantial, complete thoughts
    const completeBonus = endsSentence(rawText) ? 4 : 0;   // a finished sentence
    const hookScore = kwScore + qScore + numScore + lenScore + completeBonus;
    const posRatio = seg.start / totalSecs;
    const posScore =
      posRatio < 0.15 ? 20 : posRatio < 0.4 ? 15 : posRatio < 0.75 ? 10 : 5;

    // Penalise segments in unstable layout regions
    const rawEnd        = Math.min(seg.start + idealDur, totalSecs);
    const instability   = layoutInstabilityScore(layoutMap, seg.start, rawEnd);
    const layoutPenalty = Math.round(instability * 30); // up to -30 points

    return { ...seg, _idx: i, score: hookScore + posScore - layoutPenalty };
  });

  scored.sort((a, b) => b.score - a.score);

  const clips      = [];
  const usedRanges = [];

  // ── Pass 1: strict non-overlapping ───────────────────────────
  for (const seg of scored) {
    if (clips.length >= clipCount) break;

    const rawStart   = Math.max(0, seg.start - 1);
    const cleanStart = findCleanStart(segments, rawStart);
    const rawEnd     = cleanStart + idealDur;
    const cleanEnd   = findCleanEnd(segments, rawEnd);

    // Trim to stable layout window
    const stable     = findStableWindow(layoutMap, cleanStart, cleanEnd);
    const finalStart = stable.newStart;
    const finalEnd   = stable.newEnd;

    if (finalEnd - finalStart < 8) continue;
    if (
      usedRanges.some(
        ([s, e]) => Math.max(s, finalStart) < Math.min(e, finalEnd) - 5
      )
    )
      continue;

    const clipSegments = segments.filter(
      (s) => s.start >= finalStart - 1 && s.end <= finalEnd + 1
    );
    const transcript = JSON.stringify(clipSegments);

    const clipText = clipSegments.map((s) => s.text).join(" ");
    const title = firstSentenceSummary(clipText, 8);
    usedRanges.push([finalStart, finalEnd]);

    if (stable.wasTrimmed) {
      console.log(
        `   ✂️  Layout-trimmed clip: ${cleanStart.toFixed(1)}s-${cleanEnd.toFixed(1)}s → ${finalStart.toFixed(1)}s-${finalEnd.toFixed(1)}s (instability was ${(layoutInstabilityScore(layoutMap, cleanStart, cleanEnd) * 100).toFixed(0)}%)`
      );
    }

    clips.push({
      startSec:      finalStart,
      endSec:        finalEnd,
      title:         title.length > 5 ? title : `Highlight ${clips.length + 1}`,
      hookScore:     Math.min(88, Math.round(40 + seg.score)),
      transcript,
      contentType:   "general",
      emotion:       "neutral",
      colorGrade:    "none",
      audioMood:     "none",
      narrativeRole: "body",
      layoutStable:  stable.instability <= STABLE_THRESHOLD,
      dominantLayout: stable.dominant.mode,
      segments:      [{ startSec: finalStart, endSec: finalEnd, role: "body" }],
      directives: {
        captionPosition: "bottom",
        captionColor:    null,
        zoomIntensity:   "normal",
        pacing:          "normal",
        visualCue:       null,
        colorGrade:      "none",
        audioMood:       "none",
      },
      reason: stable.wasTrimmed ? "Rule-based (layout-trimmed)" : "Rule-based",
    });
  }

  // ── Pass 2: overlap-fill to guarantee exact clipCount ────────
  // When the strict pass can't produce enough non-overlapping clips
  // (video too short, too few scored segments), distribute remaining
  // slots evenly across the timeline. Overlapping is acceptable here.
  if (clips.length < clipCount) {
    const stillNeeded = clipCount - clips.length;
    console.log(
      `   ⚡ Rule-based strict pass gave ${clips.length}/${clipCount} — overlap fill for ${stillNeeded} more`
    );

    const zoneSize = totalSecs / stillNeeded;

    for (let z = 0; z < stillNeeded; z++) {
      if (clips.length >= clipCount) break;

      const zoneMid = z * zoneSize + zoneSize / 2;

      // Find the segment closest to the centre of this zone
      const anchor = scored.reduce((best, s) => {
        const sMid   = s.start + (s.end - s.start) / 2;
        const bestMid = best.start + (best.end - best.start) / 2;
        return Math.abs(sMid - zoneMid) < Math.abs(bestMid - zoneMid) ? s : best;
      }, scored[0]);

      const rawStart   = Math.max(0, anchor.start - 1);
      const cleanStart = findCleanStart(segments, rawStart);
      const rawEnd     = Math.min(totalSecs, cleanStart + idealDur);
      const cleanEnd   = findCleanEnd(segments, rawEnd);

      const finalStart = Math.max(0, cleanStart);
      const finalEnd   = Math.min(totalSecs, cleanEnd);
      const dur        = finalEnd - finalStart;

      if (dur < 8) continue;

      const clipSegments = segments.filter(
        (s) => s.start >= finalStart - 1 && s.end <= finalEnd + 1
      );
      const transcript = JSON.stringify(clipSegments);
      const clipText   = clipSegments.map((s) => s.text).join(" ");
      const title      = firstSentenceSummary(clipText, 8);

      const stable = findStableWindow(layoutMap, finalStart, finalEnd);

      console.log(
        `      📍 Overlap-fill rule clip ${z + 1}: ${(finalStart/60).toFixed(1)}m-${(finalEnd/60).toFixed(1)}m (${dur.toFixed(0)}s)`
      );

      clips.push({
        startSec:      finalStart,
        endSec:        finalEnd,
        title:         title.length > 5 ? title : `Highlight ${clips.length + 1}`,
        hookScore:     Math.min(75, Math.round(35 + anchor.score)),
        transcript,
        contentType:   "general",
        emotion:       "neutral",
        colorGrade:    "none",
        audioMood:     "none",
        narrativeRole: "body",
        layoutStable:  stable.instability <= STABLE_THRESHOLD,
        dominantLayout: stable.dominant.mode,
        segments:      [{ startSec: finalStart, endSec: finalEnd, role: "body" }],
        directives: {
          captionPosition: "bottom",
          captionColor:    null,
          zoomIntensity:   "normal",
          pacing:          "normal",
          visualCue:       null,
          colorGrade:      "none",
          audioMood:       "none",
        },
        reason: `Rule-based overlap-fill zone ${z + 1}`,
      });
    }
  }

  return clips;
}

// ─────────────────────────────────────────────────────────────
// POST-PROCESS: apply layout stability trimming to story-engine clips
// ─────────────────────────────────────────────────────────────

/**
 * After storyEngine produces its clips, run each one through findStableWindow.
 * If a clip is trimmed, adjust its transcript and segments accordingly.
 * If a clip's dominant layout is "split" but it has short face-only pockets,
 * those pockets are already handled by the smoother in speakerReframer — we
 * just record the dominant mode here for downstream use.
 */
function applyLayoutStability(clips, layoutMap, minWindowSecs) {
  if (!layoutMap || Object.keys(layoutMap).length === 0) return clips;

  return clips.map((clip) => {
    const stable = findStableWindow(
      layoutMap,
      clip.startSec,
      clip.endSec,
      minWindowSecs || MIN_STABLE_WINDOW
    );

    if (!stable.wasTrimmed && stable.instability <= STABLE_THRESHOLD) {
      return {
        ...clip,
        layoutStable:   true,
        dominantLayout: stable.dominant.mode,
      };
    }

    if (stable.wasTrimmed) {
      console.log(
        `   ✂️  Story clip layout-trimmed: "${clip.title}" ` +
        `${clip.startSec.toFixed(1)}s-${clip.endSec.toFixed(1)}s → ` +
        `${stable.newStart.toFixed(1)}s-${stable.newEnd.toFixed(1)}s ` +
        `(instability: ${(stable.instability * 100).toFixed(0)}% → ` +
        `${(layoutInstabilityScore(layoutMap, stable.newStart, stable.newEnd) * 100).toFixed(0)}%)`
      );
    }

    return {
      ...clip,
      startSec:       stable.newStart,
      endSec:         stable.newEnd,
      layoutStable:   stable.instability <= STABLE_THRESHOLD,
      dominantLayout: stable.dominant.mode,
      // Update the outer segments array if it's a simple single-segment clip
      segments:
        clip.segments?.length === 1
          ? [{ ...clip.segments[0], startSec: stable.newStart, endSec: stable.newEnd }]
          : clip.segments,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// BUILD layoutMap FROM speakerReframer timeline
// ─────────────────────────────────────────────────────────────

/**
 * Convert the timeline array returned by analyzeClipTimeline (or a full-video
 * scan) into a flat per-second lookup: { [integerSec]: mode }
 *
 * Call this once before selectClips, passing the full-video timeline entries.
 *
 * CHANGE 1: Normalize face_left/face_right to "face" for stability scoring.
 * These directional variants represent the same layout type (focused speaker)
 * and should not penalize clips that switch between left/right speakers.
 */
function buildLayoutMap(timelineEntries) {
  const map = {};
  if (!timelineEntries || !timelineEntries.length) return map;

  for (let i = 0; i < timelineEntries.length; i++) {
    const entry  = timelineEntries[i];
    const nextT  = i + 1 < timelineEntries.length
      ? timelineEntries[i + 1].videoTimeSec
      : entry.videoTimeSec + 1;

    let mode = entry.decision?.mode || "passthrough";
    // Normalize directional face modes — for stability scoring purposes,
    // face_left and face_right are both just "focused speaker" = "face".
    // The directional info is only relevant at the frame-rendering stage.
    if (mode === "face_left" || mode === "face_right") mode = "face";

    const startT = Math.floor(entry.videoTimeSec);
    const endT   = Math.ceil(nextT);
    for (let t = startT; t < endT; t++) {
      map[t] = mode;
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────

/**
 * selectClips
 *
 * @param {Array}  segments          - Whisper transcript segments
 * @param {number} clipCount         - EXACT number of clips requested by user
 * @param {string} clipDuration      - "auto" or e.g. "60s"
 * @param {Array}  platforms         - e.g. ["tiktok", "instagram"]
 * @param {string} videoPath         - path to source video (unused here, kept for API compat)
 * @param {Array}  fullVideoTimeline - optional: timeline entries from speakerReframer
 *                                     covering the whole video, used to build layoutMap
 */
async function selectClips(
  segments,
  clipCount    = 5,
  clipDuration = "auto",
  platforms    = [],
  videoPath    = null,
  fullVideoTimeline = null
) {
  const totalSecs = segments.length > 0 ? segments[segments.length - 1].end : 0;
  const duration  = getPlatformDuration(platforms, clipDuration);

  // Build layout stability map from full-video timeline (if available)
  const layoutMap = buildLayoutMap(fullVideoTimeline);
  const hasLayout = Object.keys(layoutMap).length > 0;

  console.log(`\n📊 Clip selection plan:`);
  console.log(
    `   Duration: ${totalSecs.toFixed(0)}s | Clips requested: ${clipCount} (exact) | Ideal: ${duration.ideal}s`
  );
  console.log(`   Platforms: ${platforms.join(", ") || "none"}`);
  console.log(`   Layout map: ${hasLayout ? `${Object.keys(layoutMap).length} seconds analysed` : "not available"}`);

  // Primary: story engine with Ollama (passes layoutMap for block-level penalties)
  let clips = null;
  try {
    const storyClips = await buildStoryClips(
      segments,
      clipCount,      // ← exact count, no capping
      duration.ideal,
      layoutMap       // ← new param
    );
    if (storyClips && storyClips.length > 0) {
      clips = storyClips;
    }
  } catch (e) {
    console.warn(`   ⚠️  Story engine: ${e.message}`);
  }

  // Fallback: rule-based
  if (!clips || clips.length === 0) {
    console.log(`   ↩️  Using rule-based fallback`);
    clips = selectWithRules(segments, clipCount, clipDuration, platforms, layoutMap);
  }

  // Apply layout-stability trimming to all clips
  if (hasLayout && clips.length > 0) {
    console.log(`\n🎨 Applying layout stability trimming...`);
    clips = applyLayoutStability(clips, layoutMap, duration.min);

    // Re-sort by start time after potential boundary shifts
    clips.sort((a, b) => a.startSec - b.startSec);

    // Log stability summary
    const stableCount   = clips.filter((c) => c.layoutStable).length;
    const unstableCount = clips.length - stableCount;
    console.log(
      `   Layout summary: ${stableCount} stable, ${unstableCount} unstable across ${clips.length} clips`
    );
    if (unstableCount > 0) {
      clips
        .filter((c) => !c.layoutStable)
        .forEach((c) =>
          console.log(
            `   ⚠️  Unstable clip: "${c.title}" (${c.startSec.toFixed(1)}s-${c.endSec.toFixed(1)}s, dominant: ${c.dominantLayout})`
          )
        );
    }
  }

  return clips;
}

module.exports = {
  selectClips,
  buildLayoutMap,
  layoutInstabilityScore,
  dominantLayout,
  findStableWindow,
};