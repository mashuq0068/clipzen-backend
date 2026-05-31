/**
 * Root.jsx
 *
 * CRITICAL: durationInFrames is now DYNAMIC via calculateMetadata.
 * This supports story-driven durations: 20s, 45s, 2min, etc.
 */

import { Composition, registerRoot } from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import "./styles.css";
import { RemotionTest } from "./RemotionTest";
import { RemotionTitleTest } from "./RemotionTitleTest";

export const RemotionRoot = () => {
  return (
    <>
      {/* ── Caption style preview (existing) ── */}
      <Composition
        id="CaptionPreview"
        component={RemotionTest}
        fps={30}
        width={1080}
        height={1920}
        // 8 words × 0.55s ≈ 4.4s → ~132 frames.  200 gives safe headroom.
        durationInFrames={200}
      />

      {/* ── Title style preview (NEW) ────────────────────────────────────────
           Pick any title from the dropdown in the Remotion player.
           Gradient-text styles use SVG fill instead of WebkitBackgroundClip
           so they render correctly during encoding too.
      ─────────────────────────────────────────────────────────────────────── */}
      <Composition
        id="TitlePreview"
        component={RemotionTitleTest}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={200}
      />

      {/* ── Full captioned clip (existing) ── */}
      <Composition
        id="CaptionedClip"
        component={CaptionedVideo}
        fps={30}
        width={1080}
        height={1920}
        // DYNAMIC DURATION: Calculates frames from clipDurationSecs prop
        // Supports any duration: 20s (600f), 45s (1350f), 2min (3600f), etc.
        calculateMetadata={({ props }) => {
          const durationSecs = props?.clipDurationSecs || 60; // fallback 60s
          const fps = props?.fps || 30;
          // Dimensions are driven by props so add-captions can keep the SOURCE
          // size (no reframe). Defaults to vertical 1080x1920 for everything else.
          const width = props?.renderWidth || 1080;
          const height = props?.renderHeight || 1920;
          return {
            durationInFrames: Math.ceil(durationSecs * fps),
            width,
            height,
          };
        }}
        defaultProps={{
          videoSrc: "",
          words: [],
          style: {
            name: "wordpop",
            layout: "bottom-center",
            textColor: "#FFFFFF",
            activeColor: "#FFE000", // Yellow for wordpop
            strokeColor: "#000000",
            strokeWidth: 8,
            bgBoxColor: "rgba(0,0,0,0.0)",
            fontSize: 62,
            animation: "scale",
            fontFamily: "Montserrat",
            fontWeight: 900,
            uppercase: true,
            wordsPerLine: 3,
            lineSpacing: 1.15,
            shadow: "0 4px 16px rgba(0,0,0,0.8)",
          },
          fps: 30,
          clipDurationSecs: 60, // Default for preview only
          zoomCurve: [
            { t: 0, zoom: 1.0 },
            { t: 60, zoom: 1.0 },
          ],
          events: [],
          emojiOverlays: [],
          lowerThird: null,
          showProgressBar: true,
          emotion: "neutral",
          contentType: "general",
          colorGrade: "none",
          speakerSegments: [],
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
