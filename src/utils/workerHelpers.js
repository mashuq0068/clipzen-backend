const { analyzeClipTimeline } = require("../services/speakerReframer");

function extractWordTimingsForStitchedClip(transcriptSegments, clipSegments) {
  const allWords = [];
  for (const seg of clipSegments) {
    const segStart = seg.startSec || 0;
    const segEnd = seg.endSec || 0;
    if (segEnd <= segStart) continue;
    for (const tSeg of transcriptSegments) {
      if (!tSeg.words || !Array.isArray(tSeg.words)) continue;
      for (const w of tSeg.words) {
        const wStart = w.start ?? w.startSec ?? 0;
        const wEnd = w.end ?? w.endSec ?? wStart + 0.1;
        if (wStart >= segStart - 0.15 && wStart < segEnd + 0.15) {
          allWords.push({
            word: (w.word || w.text || "").replace(/[^\w\s'''-]/g, "").trim(),
            startSec: wStart,
            endSec: wEnd,
            index: 0,
          });
        }
      }
    }
  }
  const seen = new Set();
  const deduped = allWords.filter((w) => {
    if (!w.word) return false;
    const key = `${w.startSec.toFixed(3)}_${w.word}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.startSec - b.startSec);
  return deduped.map((w, i) => ({ ...w, index: i }));
}

async function analyzeClipTimelineForClip(videoPath, clip) {
  const isStitched = clip.segments && clip.segments.length > 1;

  if (!isStitched) {
    return analyzeClipTimeline(videoPath, clip.startSec, clip.endSec);
  }

  let combinedTimeline = [];
  let srcW = 1920, srcH = 1080, isAlreadyVertical = false;
  let clipTimeOffset = 0; 

  for (const seg of clip.segments) {
    const segDur = seg.endSec - seg.startSec;
    if (segDur <= 0) continue;

    const result = await analyzeClipTimeline(videoPath, seg.startSec, seg.endSec);
    srcW = result.srcW;
    srcH = result.srcH;
    isAlreadyVertical = result.isAlreadyVertical;

    if (result.isAlreadyVertical || result.timeline.length === 0) {
      combinedTimeline.push({
        videoTimeSec: seg.startSec,
        clipTimeSec: clipTimeOffset,
        faceCount: 0,
        decision: { mode: "passthrough" },
      });
    } else {
      for (const entry of result.timeline) {
        combinedTimeline.push({
          ...entry,
          clipTimeSec: parseFloat((clipTimeOffset + entry.clipTimeSec).toFixed(2)),
        });
      }
    }
    clipTimeOffset += segDur;
  }

  return { timeline: combinedTimeline, srcW, srcH, isAlreadyVertical };
}

const STABLE_TRIM_MIN_FRAC  = 0.80; 
const STABLE_TRIM_MIN_DUR   = 20;   
const STABLE_TRIM_MAX_LOSS  = 0.45; 

function trimToStableLayoutWindow(clip, timeline) {
  const clipStart = clip.startSec;
  const clipEnd   = clip.endSec;
  const clipDur   = clipEnd - clipStart;

  if (timeline.length < 4 || clipDur < STABLE_TRIM_MIN_DUR * 2) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd };
  }

  const votes = {};
  for (const e of timeline) {
    const m = e.decision.mode;
    votes[m] = (votes[m] || 0) + 1;
  }
  const total = timeline.length;
  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [dominantMode, dominantCount] = sorted[0];
  const dominantFrac = dominantCount / total;

  if (dominantFrac >= STABLE_TRIM_MIN_FRAC) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  let bestRunStart = -1, bestRunEnd = -1, bestRunLen = 0;
  let curRunStart = -1, curRunLen = 0;

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (entry.decision.mode === dominantMode) {
      if (curRunStart < 0) curRunStart = i;
      curRunLen++;
      if (curRunLen > bestRunLen) {
        bestRunLen = curRunLen;
        bestRunStart = curRunStart;
        bestRunEnd = i;
      }
    } else {
      curRunStart = -1;
      curRunLen = 0;
    }
  }

  if (bestRunStart < 0) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  const runStartT = clipStart + (timeline[bestRunStart].clipTimeSec || 0);
  const runEndEntry = timeline[bestRunEnd];
  const nextEntry = bestRunEnd + 1 < timeline.length ? timeline[bestRunEnd + 1] : null;
  const runEndT = clipStart + (nextEntry ? nextEntry.clipTimeSec : (runEndEntry.clipTimeSec + 1));

  const trimmedDur = runEndT - runStartT;
  const lostFrac   = 1 - trimmedDur / clipDur;

  if (trimmedDur < STABLE_TRIM_MIN_DUR || lostFrac > STABLE_TRIM_MAX_LOSS) {
    return { wasTrimmed: false, startSec: clipStart, endSec: clipEnd, dominantMode, dominantFrac };
  }

  const trimmedFrac = bestRunLen / total;
  return {
    wasTrimmed:    true,
    startSec:      parseFloat(runStartT.toFixed(2)),
    endSec:        parseFloat(runEndT.toFixed(2)),
    dominantMode,
    dominantFrac:  trimmedFrac,
  };
}

function trimToTimelineWindow(timeline, newVideoStart, newVideoEnd, originalVideoStart) {
  const relStart = newVideoStart - originalVideoStart;
  const relEnd   = newVideoEnd   - originalVideoStart;
  const sliced = timeline.filter(
    (e) => e.clipTimeSec >= relStart - 0.1 && e.clipTimeSec <= relEnd + 0.1
  );
  return sliced.map((e) => ({
    ...e,
    clipTimeSec: parseFloat(Math.max(0, e.clipTimeSec - relStart).toFixed(2)),
  }));
}

module.exports = {
  extractWordTimingsForStitchedClip,
  analyzeClipTimelineForClip,
  trimToStableLayoutWindow,
  trimToTimelineWindow
};
