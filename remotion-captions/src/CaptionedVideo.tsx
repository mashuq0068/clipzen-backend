import React from "react";
import {
  AbsoluteFill,
  Video,
  useCurrentFrame,
  interpolate,
  spring,
  Easing,
  staticFile,
  OffthreadVideo,
  Sequence,
} from "remotion";

// ─────────────────────────────────────────────────────────────
// VIDEO SRC RESOLVER
//
// captionBurner passes mainVideoUrl as a full HTTP URL served by
// the local broll server. staticFile() hard-crashes on remote URLs.
// resolveVideoSrc() passes HTTP URLs through and only calls
// staticFile() for local asset names like "video_xxx.mp4".
// ─────────────────────────────────────────────────────────────
function resolveVideoSrc(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }
  return staticFile(src);
}

// ─────────────────────────────────────────────────────────────
// TYPES

// ─────────────────────────────────────────────────────────────
export interface StyleConfig {
  extrudeColor?: string;
  extrudeDepth?: number;
  bgSlideColor?: string;
  bgSlideTextColor?: string;
  bgSlideRadius?: number;
  name: string;
  layout: string;
  textColor: string;
  activeColor: string;
  strokeColor: string;
  strokeWidth: number;
  bgBoxColor: string;
  fontSize: number;
  animation: string;
  activeStrategy?: string;
  fontFamily: string;
  fontWeight: number;
  uppercase: boolean;
  wordsPerLine: number;
  lineSpacing: number;
  shadow: string;
  letterSpacing?: string;
  fontStyle?: string;
  borderRadius?: number;
  padding?: string;
  border?: string;
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
  backdropBlur?: number;
  boxShadow?: string;
  activeBg?: string;
  activeTextColor?: string;
  activeScale?: number;
  activeGlow?: string;
  activeUnderlineColor?: string;
  activeUnderlineHeight?: number;
  activeShadow?: string;
  activeFontStyle?: string;
  activeFontWeight?: number;
  activeInnerBg?: string;
  activePillRadius?: number;
  activePadding?: string;
  activeBorderRadius?: number;
  pillRadius?: number;
  sweepColor?: string;
  sweepDuration?: number;
  gradient?: string;
  gradientSize?: string;
  glowColor?: string;
  alternateFontFamily?: string;
  alternateFontWeight?: number;
  alternateUppercase?: boolean;
  alternateLetterSpacing?: string;
  cursorColor?: string;
  activeGlowR?: string;
  activeGlowC?: string;
  highlightBg?: string;
  highlightTextColor?: string;
  highlightPaddingX?: number;
  highlightPaddingY?: number;
  highlightRadius?: number;
  positionBottom?: number | string;
  positionTop?: number | string;
  positionLeft?: number | string;
  positionRight?: number | string;
  positionTransform?: string;
  offsetX?: number;
  offsetY?: number;
}

interface Word {
  word: string;
  startSec: number;
  endSec: number;
  index: number;
}

interface EmojiOverlay {
  emoji?: string;
  icon?: string;
  atSec: number;
  x: number;
  y: number;
  size: number;
}

interface BrollSegment {
  keyword: string;
  videoUrl: string;
  startSec: number;
  durationSec: number;
  style: "fullscreen" | "pip";
  position?: "bottom" | "top";
}

interface WordEmphasisEvent {
  wordIndex: number;
  colorOverride: string | null;
  level: number;
  emphasisScale?: number; // font-size multiplier (1.0–1.6)
  floatKeyword?: boolean; // render as floating overlay above caption line
  animationType?: string; // punch_in | slam_down | zoom_burst | scale_pop | pulse
  captionLayout?: string; // float_top | impact_center | inline_hero | inline
}

interface Props {
  videoSrc: string;
  words: Word[];
  style: StyleConfig;
  fps: number;
  clipDurationSecs?: number;
  emojiOverlays?: EmojiOverlay[];
  brollSegments?: BrollSegment[];
  splitTimeline?: Array<{ startSec: number; endSec: number }>;
  emphasisEvents?: WordEmphasisEvent[];
  titleEnabled?: boolean;
  titleText?: string;
  titleStyle?: any;
  titlePosition?: string;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
export function getStrokeValue(s: StyleConfig): string | undefined {
  return undefined;
}

export function getLayoutPosition(
  layout: string,
  style?: StyleConfig,
): React.CSSProperties {
  let baseLayout: React.CSSProperties = {};
  switch (layout) {
    case "top-left":
      baseLayout = { top: 60, left: 20, right: 20 };
      break;
    case "center":
      baseLayout = {
        top: "50%",
        left: 20,
        right: 20,
        transform: "translateY(-50%)",
      };
      break;
    case "bottom-right":
      baseLayout = { bottom: 80, right: 20, left: "auto", maxWidth: "75%" };
      break;
    case "bottom-left":
      baseLayout = { bottom: 80, left: 20, right: "auto", maxWidth: "80%" };
      break;
    case "bottom-center":
    default:
      baseLayout = { bottom: 280, left: 40, right: 40 };
      break;
  }

  if (style) {
    if (style.offsetX !== undefined || style.offsetY !== undefined) {
      const merged = { ...baseLayout };
      const tx = style.offsetX || 0;
      const ty = style.offsetY || 0;

      if (tx !== 0 || ty !== 0) {
        const baseTransform = merged.transform ? `${merged.transform} ` : "";
        merged.transform = `${baseTransform}translate(${tx}px, ${ty}px)`;
      }
      return merged;
    }
  }

  return baseLayout;
}

export function getAlignItems(
  layout: string,
): React.CSSProperties["alignItems"] {
  switch (layout) {
    case "top-left":
    case "bottom-left":
      return "flex-start";
    case "bottom-right":
      return "flex-end";
    default:
      return "center";
  }
}

export function getFlexAlign(
  layout: string,
): React.CSSProperties["justifyContent"] {
  switch (layout) {
    case "top-left":
    case "bottom-left":
      return "flex-start";
    case "bottom-right":
      return "flex-end";
    default:
      return "center";
  }
}

// ─────────────────────────────────────────────────────────────
// OUTLINE SHADOW BUILDER
// ─────────────────────────────────────────────────────────────
export function buildOutlineShadow(strokeColor: string, size: number): string {
  const s = Math.round(size);
  const h = Math.round(size * 0.5);
  return [
    `-${s}px -${s}px 0 ${strokeColor}`,
    ` ${s}px -${s}px 0 ${strokeColor}`,
    `-${s}px  ${s}px 0 ${strokeColor}`,
    ` ${s}px  ${s}px 0 ${strokeColor}`,
    `-${s}px 0 0 ${strokeColor}`,
    ` ${s}px 0 0 ${strokeColor}`,
    `0 -${s}px 0 ${strokeColor}`,
    `0  ${s}px 0 ${strokeColor}`,
    `-${h}px -${h}px 0 ${strokeColor}`,
    ` ${h}px -${h}px 0 ${strokeColor}`,
    `-${h}px  ${h}px 0 ${strokeColor}`,
    ` ${h}px  ${h}px 0 ${strokeColor}`,
    `-${h}px 0 0 ${strokeColor}`,
    ` ${h}px 0 0 ${strokeColor}`,
    `0 -${h}px 0 ${strokeColor}`,
    `0  ${h}px 0 ${strokeColor}`,
  ].join(", ");
}

// ─────────────────────────────────────────────────────────────
// ACTIVE STRATEGY RESULT TYPE
// ─────────────────────────────────────────────────────────────
interface ActiveStrategyResult {
  color?: string;
  opacity?: number;
  transform?: string;
  textShadow?: string;
  letterSpacing?: string;
  fontStyle?: string;
  fontWeight?: number;
  fontFamily?: string;
  background?: string;
  backgroundClip?: string;
  webkitBackgroundClip?: string;
  webkitTextFillColor?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  padding?: string;
  borderRadius?: number;
  borderBottom?: string;
  showUnderline?: boolean;
  underlineWidth?: number;
  showCursor?: boolean;
  boxBg?: string;
  boxPaddingX?: number;
  boxPaddingY?: number;
  boxRadius?: number;
  boxTextColor?: string;
  boxScale?: number;
  // bg_slide specific — consumed by AnimatedWord to render wipe bg
  bgSlideWidthPct?: number;
  bgSlideColor?: string;
  bgSlideTextColor?: string;
  bgSlideRadius?: number;
  boxShadow?: string;
  showTape?: boolean;
  tapeColor?: string;
  tapeHeight?: number;
}

// ─────────────────────────────────────────────────────────────
// ACTIVE STRATEGY
// ─────────────────────────────────────────────────────────────
export function computeActiveStrategy(params: {
  isActive: boolean;
  captionStyle: StyleConfig;
  frameInGroup: number;
  fps: number;
  index: number;
  fontSize: number;
  word: string;
  isAltFont: boolean;
  baseOpacity: number;
  baseTransform: string;
}): ActiveStrategyResult {
  const { isActive, captionStyle: s, frameInGroup, fps } = params;
  const baseShadow = s.shadow && s.shadow !== "none" ? s.shadow : undefined;

  switch (s.activeStrategy) {
    // ── bg_pill ────────────────────────────────────────────────
    // Classic solid pill background — simple, reliable, works with every animation.
    case "bg_pill": {
      return {
        color: isActive ? s.activeTextColor || "#FFFFFF" : s.textColor,
        background: isActive
          ? s.activeBg || s.activeColor || "#FF4444"
          : "transparent",
        padding: isActive ? "2px 10px" : "2px 4px",
        borderRadius: isActive ? (s.pillRadius ?? 8) : 0,
        textShadow: !isActive ? baseShadow : undefined,
      };
    }

    // ── bg_slide ───────────────────────────────────────────────
    // NEW: Pill background that WIPES in left→right when a word becomes active.
    // Looks like a highlighter being drawn across the word in real time.
    // The AnimatedWord component reads bgSlideWidthPct and renders a
    // position:absolute <span> behind the text that grows from 0%→100%.
    // Works with every animation — especially great with word_pop + slide_reveal.
    // ── bg_slide ───────────────────────────────────────────────
    // Pill bg that wipes in left→right over 10 frames when word becomes active.
    case "bg_slide": {
      const slideColor =
        s.bgSlideColor || s.activeBg || s.activeColor || "#FF4444";
      const slideTextColor =
        s.bgSlideTextColor || s.activeTextColor || "#FFFFFF";
      const slideRadius = s.bgSlideRadius ?? s.pillRadius ?? 8;

      if (!isActive) {
        return {
          color: s.textColor,
          textShadow: baseShadow,
          bgSlideWidthPct: 0,
          bgSlideColor: slideColor,
          bgSlideTextColor: s.textColor,
          bgSlideRadius: slideRadius,
        };
      }

      const wipeProgress = interpolate(frameInGroup, [0, 10], [0, 100], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

      return {
        color: slideTextColor,
        textShadow: undefined,
        bgSlideWidthPct: wipeProgress,
        bgSlideColor: slideColor,
        bgSlideTextColor: slideTextColor,
        bgSlideRadius: slideRadius,
      };
    }

    // ── extrude_3d ─────────────────────────────────────────────
    // Recreates the screenshot look: active word turns red + gets a stacked
    // 3D block extrusion stepping down-right — like comic/street block letters.
    // Built from layered text-shadow offsets at 1px steps creating a solid
    // volumetric face. Outline shadow is rebuilt on top so stroke stays sharp.
    // The animation transform is preserved — activeScale multiplies on top.
    case "extrude_3d": {
      const activeColor = s.activeTextColor || "#FFFFFF";
      const boxColor = s.activeBg || "#FF2020";
      const extrudeDepth = s.extrudeDepth ?? 8;

      if (!isActive) {
        return {
          color: s.textColor,
          textShadow: baseShadow,
        };
      }

      const tapeHeightFactor = 0.2 + ((s.extrudeDepth ?? 8) / 40) * 0.6; // Scale 20% to 80%

      return {
        color: activeColor,
        showTape: true,
        tapeColor: boxColor,
        tapeHeight: s.fontSize * tapeHeightFactor,
        textShadow: undefined,
      };
    }

    // ── neon_glow ──────────────────────────────────────────────
    // Oscillating electric glow on the active word. Pulse driven by sin wave.
    case "neon_glow": {
      const glowPulse = Math.sin(frameInGroup * 0.18) * 0.5 + 0.5;
      const glowSize1 = Math.round(18 + glowPulse * 18);
      const glowSize2 = Math.round(36 + glowPulse * 28);
      const activeColor = s.activeColor || "#FF00FF";
      const glowShadow = isActive
        ? `0 0 ${glowSize1}px ${activeColor}, 0 0 ${glowSize2}px ${activeColor}88`
        : baseShadow;
      return {
        color: isActive ? activeColor : s.textColor,
        textShadow: glowShadow,
      };
    }

    // ── cursor_blink ───────────────────────────────────────────
    // Active word gets a blinking block cursor rendered after it.
    // AnimatedWord renders the cursor span when showCursor=true.
    case "cursor_blink": {
      return {
        color: isActive ? s.activeColor || "#FFD700" : s.textColor,
        showCursor: isActive,
        textShadow: baseShadow,
      };
    }

    // ── shimmer ────────────────────────────────────────────────
    // FIXED: Seamless looping gold gradient sweep on the active word.
    // Uses modulo-based position (not clamp) so the loop never jumps.
    case "shimmer": {
      if (!isActive) {
        return { color: s.textColor, textShadow: baseShadow };
      }
      // Smooth loop: position cycles 0→200% over 60 frames continuously
      const sweepPos = ((frameInGroup % 45) / 45) * 200;

      // High-end cinematic gradient (Silver/Gold/White mix)
      const cinematicGradient =
        "linear-gradient(90deg, #FFFFFF 0%, #D4AF37 25%, #FFFFFF 50%, #D4AF37 75%, #FFFFFF 100%)";

      return {
        color: "transparent",
        background: s.gradient || cinematicGradient,
        backgroundClip: "text",
        backgroundSize: "200% 100%",
        backgroundPosition: `${sweepPos}% 0`,
        webkitBackgroundClip: "text",
        webkitTextFillColor: "transparent",
        // Add a subtle drop shadow to make it pop even without outline
        textShadow: "0 2px 10px rgba(0,0,0,0.5)",
      };
    }

    case "linear_gradient": {
      const sweepPos = ((frameInGroup % 90) / 90) * 160;
      const premiumGradient =
        s.gradient ||
        "linear-gradient(110deg, #FF4FD8 0%, #8B5CFF 36%, #30D5FF 72%, #FF7A3D 100%)";

      return {
        color: "transparent",
        background: premiumGradient,
        backgroundClip: "text",
        backgroundSize: s.gradientSize || "180% 100%",
        backgroundPosition: isActive ? `${sweepPos}% 0` : "50% 0",
        webkitBackgroundClip: "text",
        webkitTextFillColor: "transparent",
        textShadow: isActive
          ? s.activeGlow ||
            "0 0 22px rgba(196,84,255,0.42), 0 10px 34px rgba(0,0,0,0.55)"
          : baseShadow,
      };
    }
    case "rim_light": {
      const breathe = Math.sin(frameInGroup * 0.12) * 0.5 + 0.5;
      const innerGlow = Math.round(10 + breathe * 8);
      const outerGlow = Math.round(28 + breathe * 20);
      const farGlow = Math.round(55 + breathe * 30);
      const activeColor = s.activeColor || "#FFE88A";

      if (!isActive) {
        return {
          color: "#FFFFFF",
          textShadow: undefined, // ← plain white, no glow
        };
      }

      return {
        color: "#FFFFFF",
        textShadow: `0 0 ${innerGlow}px ${activeColor}, 0 0 ${outerGlow}px ${activeColor}BB, 0 0 ${farGlow}px ${activeColor}44`,
      };
    }

    // ── gradient_glow ──────────────────────────────────────────
    // Every word gets the gradient text fill AND a constant soft halo glow.
    // The active word: brighter pulsing glow + animated gradient sweep.
    // This is the premium Instagram/TikTok feel — readable, always luminous,
    // active word still snaps your eye without losing the look on neighbors.
    //
    // Fields read: gradient, gradientSize, glowColor, activeGlow.
    // Falls back to a pink→purple→cyan premium gradient if none given.
    case "gradient_glow": {
      const premiumGradient =
        s.gradient ||
        "linear-gradient(115deg, #FFE1F7 0%, #FF4FD8 25%, #8B5CFF 55%, #30D5FF 85%, #FFFFFF 100%)";
      const glowColor = s.glowColor || s.activeColor || "#FF4FD8";

      // Constant baseline glow on every word
      const baseGlow = `0 0 10px ${glowColor}66, 0 0 26px ${glowColor}33, 0 8px 28px rgba(0,0,0,0.55)`;

      // Active gets pulsing brighter glow + a continuously sweeping gradient
      const pulse = Math.sin(frameInGroup * 0.18) * 0.5 + 0.5;
      const activeInner = Math.round(14 + pulse * 14);
      const activeOuter = Math.round(34 + pulse * 24);
      const activeFar = Math.round(60 + pulse * 28);
      const activeGlowStr =
        s.activeGlow ||
        `0 0 ${activeInner}px ${glowColor}, 0 0 ${activeOuter}px ${glowColor}AA, 0 0 ${activeFar}px ${glowColor}55, 0 10px 34px rgba(0,0,0,0.55)`;

      const sweepPos = ((frameInGroup % 90) / 90) * 160;

      return {
        color: "transparent",
        background: premiumGradient,
        backgroundClip: "text",
        backgroundSize: s.gradientSize || "200% 100%",
        backgroundPosition: isActive ? `${sweepPos}% 0` : "50% 0",
        webkitBackgroundClip: "text",
        webkitTextFillColor: "transparent",
        textShadow: isActive ? activeGlowStr : baseGlow,
      };
    }

    // ── default ────────────────────────────────────────────────
    default: {
      return {
        color: isActive ? s.activeColor : s.textColor,
        textShadow: baseShadow,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ANIMATED WORD
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ANIMATED WORD — drop-in replacement for the AnimatedWord
// defined inside CaptionedVideo.tsx.
//
// Fixes vs the old inline version:
//   1. Typewriter: removed dead `displayWord` variable; outer span
//      stays opacity:1 always so individual chars self-animate cleanly.
//   2. Extrude_3D tape: no longer uses zIndex:-1 (which fights Remotion's
//      stacking contexts). Tape renders first in DOM order; text sits in
//      a position:relative / zIndex:1 inner wrapper above it naturally.
//   3. Outer span: zIndex:0 removed — we no longer need to manufacture
//      a stacking context, so we don't accidentally trap children.
// ─────────────────────────────────────────────────────────────

export const AnimatedWord: React.FC<{
  word: string;
  isActive: boolean;
  index: number;
  captionStyle: StyleConfig;
  frameInGroup: number;
  fps: number;
  isAltFont: boolean;
  totalWords: number;
  emphasisColorOverride?: string | null;
  emphasisScale?: number;
  animationType?: string;
}> = ({
  word,
  isActive,
  index,
  captionStyle,
  frameInGroup,
  fps,
  isAltFont,
  totalWords,
  emphasisColorOverride,
  emphasisScale = 1.0,
  animationType,
}) => {
  const s = captionStyle;
  const baseSize = s.fontSize;

  // ── Entry timing ───────────────────────────────────────────
  const entryStart = index * 4;
  const entryEnd = entryStart + 14;

  // ── fontSize pop for scale animation only ──────────────────
  const activePopSpring = spring({
    frame: frameInGroup,
    fps,
    config: { damping: 16, stiffness: 200, mass: 0.7 },
  });

  // emphasisScale drives dynamic word sizing: peak3=1.55x, peak2=1.28x, peak1=1.12x
  // This is the core of the "bigger important words" feature
  const effectiveEmphasisScale =
    isActive && emphasisScale > 1.0 ? emphasisScale : 1.0;

  let fontSize: number;
  if (s.animation === "scale") {
    fontSize = isActive
      ? interpolate(
          activePopSpring,
          [0, 1],
          [baseSize * 0.84, baseSize * 1.03],
        ) * effectiveEmphasisScale
      : baseSize * 0.84;
  } else {
    // Non-scale animations: apply emphasisScale smoothly via spring when active
    if (isActive && emphasisScale > 1.0) {
      const emphSpring = spring({
        frame: frameInGroup,
        fps,
        config: { damping: 18, stiffness: 280, mass: 0.6 },
      });
      fontSize =
        baseSize *
        interpolate(emphSpring, [0, 1], [1.0, effectiveEmphasisScale], {
          extrapolateRight: "clamp",
        });
    } else {
      fontSize = baseSize;
    }
  }

  // ── Per-animation transform / opacity / filter ─────────────
  let transform = "none";
  let opacity = 1;
  let filter = "none";
  let transformOrigin = "center center";

  switch (s.animation) {
    // ── bounce ───────────────────────────────────────────────
    case "bounce": {
      const entryProgress = interpolate(
        frameInGroup,
        [entryStart, entryEnd],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 16, stiffness: 220, mass: 0.8 },
      });
      const yVal = interpolate(sp, [0, 1], [-60, 0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(entryProgress, [0, 0.25], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `translateY(${yVal}px)`;
      break;
    }

    // ── deco_drop ────────────────────────────────────────────
    case "deco_drop": {
      const ep = interpolate(frameInGroup, [entryStart, entryEnd], [0, 1], {
        easing: Easing.out(Easing.back(1.5)),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const yVal = interpolate(ep, [0, 1], [-20, 0], {
        extrapolateRight: "clamp",
      });
      const rotVal = interpolate(
        frameInGroup,
        [entryStart, entryStart + 8],
        [-2, 0],
        { extrapolateRight: "clamp" },
      );
      opacity = interpolate(ep, [0, 0.35], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `translateY(${yVal}px) rotate(${rotVal}deg)`;
      break;
    }

    // ── scale ────────────────────────────────────────────────
    case "scale": {
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 14, stiffness: 260, mass: 0.7 },
      });
      const ep = interpolate(frameInGroup, [entryStart, entryEnd], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const scaleVal = interpolate(sp, [0, 1], [0.5, 1.0]);
      opacity = interpolate(ep, [0, 0.2], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `scale(${Math.min(scaleVal, 1.0)})`;
      break;
    }

    // ── word_pop ─────────────────────────────────────────────
    case "word_pop": {
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 10, stiffness: 320, mass: 0.55 },
      });
      const scaleVal = interpolate(sp, [0, 1], [0.0, 1.18], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(
        frameInGroup,
        [entryStart, entryStart + 3],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      transform = `scale(${scaleVal})`;
      break;
    }

    // ── zoom_punch ───────────────────────────────────────────
    case "zoom_punch": {
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 18, stiffness: 400, mass: 0.6 },
      });
      const scaleVal = interpolate(sp, [0, 1], [1.6, 1.0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(
        frameInGroup,
        [entryStart, entryStart + 2],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      transform = `scale(${scaleVal})`;
      break;
    }

    // ── slide_reveal ─────────────────────────────────────────
    case "slide_reveal": {
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 20, stiffness: 300, mass: 0.65 },
      });
      const xVal = interpolate(sp, [0, 1], [-80, 0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(
        frameInGroup,
        [entryStart, entryStart + 6],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      transform = `translateX(${xVal}px)`;
      break;
    }

    // ── fade_up ──────────────────────────────────────────────
    case "fade_up": {
      const fadeProgress = interpolate(
        frameInGroup,
        [entryStart, entryEnd],
        [0, 1],
        {
          easing: Easing.out(Easing.cubic),
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        },
      );
      const yVal = interpolate(fadeProgress, [0, 1], [22, 0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(fadeProgress, [0, 0.5], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `translateY(${yVal}px)`;
      break;
    }

    // ── blur_in ──────────────────────────────────────────────
    case "blur_in": {
      const bp = interpolate(frameInGroup, [entryStart, entryEnd], [0, 1], {
        easing: Easing.out(Easing.quad),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const blurPx = interpolate(bp, [0, 1], [18, 0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(bp, [0, 0.45], [0, 1], {
        extrapolateRight: "clamp",
      });
      filter = `blur(${blurPx}px)`;
      transform = "none";
      break;
    }

    // ── pop_up ───────────────────────────────────────────────
    case "pop_up": {
      const sp = spring({
        frame: frameInGroup - entryStart,
        fps,
        config: { damping: 12, stiffness: 280, mass: 0.6 },
      });
      const yVal = interpolate(sp, [0, 1], [70, 0], {
        extrapolateRight: "clamp",
      });
      const scaleVal = interpolate(sp, [0, 1], [0.55, 1.0], {
        extrapolateRight: "clamp",
      });
      opacity = interpolate(
        frameInGroup,
        [entryStart, entryStart + 5],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      transform = `translateY(${yVal}px) scale(${scaleVal})`;
      break;
    }

    // ── swing ────────────────────────────────────────────────
    case "swing": {
      transformOrigin = "top center";
      const sp = interpolate(frameInGroup, [entryStart, entryEnd], [0, 1], {
        easing: Easing.out(Easing.elastic(1.2)),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const yVal = interpolate(sp, [0, 1], [-50, 0], {
        extrapolateRight: "clamp",
      });
      const rotVal = interpolate(
        frameInGroup,
        [entryStart, entryStart + 5, entryStart + 9, entryStart + 12, entryEnd],
        [-18, 10, -5, 2, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      opacity = interpolate(sp, [0, 0.2], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `translateY(${yVal}px) rotate(${rotVal}deg)`;
      break;
    }

    // ── glitch ───────────────────────────────────────────────
    case "glitch": {
      const settled = frameInGroup > entryEnd;
      if (!settled) {
        const jitterAmp = interpolate(
          frameInGroup,
          [entryStart, entryStart + 10, entryEnd],
          [20, 5, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        const jitterX = Math.sin(frameInGroup * Math.PI * 2.3) * jitterAmp;
        opacity = interpolate(
          frameInGroup,
          [entryStart, entryStart + 4, entryStart + 7, entryEnd],
          [0, 1, 0.4, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        transform = `translateX(${jitterX}px)`;
      } else {
        transform = "none";
        opacity = 1;
      }
      break;
    }

    // ── typewriter ───────────────────────────────────────────
    // FIX: outer span stays opacity:1 always.
    // Character visibility is handled entirely by the per-char
    // opacity/scale inside the JSX below — no outer snap needed.
    case "typewriter": {
      opacity = 1; // ← was: visibleChars > 0 ? 1 : 0  (caused hard snap)
      transform = "none";
      filter = "none";
      break;
    }

    case "none":
    default:
      opacity = 1;
      transform = "none";
      break;
  }

  // ── animationType — driven by editingDirector emphasis events ──────────
  // These override/augment the caption style animation for emphasized words.
  // Only fires when the word is active AND has a special animationType.
  if (
    isActive &&
    animationType &&
    animationType !== "none" &&
    animationType !== "pulse"
  ) {
    switch (animationType) {
      // punch_in: word smashes in from large → settles. Peak3 signature move.
      case "punch_in": {
        const punchSpring = spring({
          frame: frameInGroup,
          fps,
          config: { damping: 22, stiffness: 500, mass: 0.5 },
        });
        const punchScale = interpolate(punchSpring, [0, 1], [2.2, 1.0], {
          extrapolateRight: "clamp",
        });
        const punchOpacity = interpolate(frameInGroup, [0, 3], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        transform = `scale(${punchScale})`;
        opacity = punchOpacity;
        break;
      }
      // slam_down: drops from above with heavy impact feel
      case "slam_down": {
        const slamSpring = spring({
          frame: frameInGroup,
          fps,
          config: { damping: 28, stiffness: 600, mass: 0.8 },
        });
        const yVal = interpolate(slamSpring, [0, 1], [-120, 0], {
          extrapolateRight: "clamp",
        });
        const scaleVal = interpolate(slamSpring, [0, 1], [1.4, 1.0], {
          extrapolateRight: "clamp",
        });
        const slamOpacity = interpolate(frameInGroup, [0, 2], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        transform = `translateY(${yVal}px) scale(${scaleVal})`;
        opacity = slamOpacity;
        break;
      }
      // zoom_burst: explosive scale-in from tiny → overshoot → settle
      case "zoom_burst": {
        const burstSpring = spring({
          frame: frameInGroup,
          fps,
          config: { damping: 10, stiffness: 450, mass: 0.4 },
        });
        const burstScale = interpolate(burstSpring, [0, 1], [0.0, 1.12], {
          extrapolateRight: "clamp",
        });
        const burstOpacity = interpolate(frameInGroup, [0, 2], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        transform = `scale(${burstScale})`;
        opacity = burstOpacity;
        break;
      }
      // scale_pop: clean pop — used for peak2 words
      case "scale_pop": {
        const popSpring = spring({
          frame: frameInGroup,
          fps,
          config: { damping: 14, stiffness: 320, mass: 0.6 },
        });
        const popScale = interpolate(popSpring, [0, 1], [0.6, 1.0], {
          extrapolateRight: "clamp",
        });
        transform = `scale(${Math.min(popScale, 1.08)})`;
        opacity = interpolate(frameInGroup, [0, 4], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        break;
      }
    }
  }

  // pulse: continuous heartbeat on active word (peak1)
  if (isActive && animationType === "pulse") {
    const pulseScale = 1.0 + Math.sin(frameInGroup * 0.22) * 0.04;
    transform = `scale(${pulseScale})`;
  }

  // ── Active strategy ───────────────────────────────────────
  const activeResult = computeActiveStrategy({
    isActive,
    captionStyle: s,
    frameInGroup,
    fps,
    index,
    fontSize,
    word,
    isAltFont,
    baseOpacity: opacity,
    baseTransform: transform,
  });

  // ── emphasisColorOverride ─────────────────────────────────
  if (isActive && emphasisColorOverride) {
    activeResult.color = emphasisColorOverride;
    if (activeResult.webkitTextFillColor) {
      activeResult.webkitTextFillColor = emphasisColorOverride;
      activeResult.background = undefined;
      activeResult.webkitBackgroundClip = undefined;
    }
  }

  // ── Outline shadow ────────────────────────────────────────
  const outlineColor =
    s.strokeWidth > 0 && s.strokeColor !== "transparent"
      ? s.strokeColor
      : s.textColor === "#FFFFFF" || s.textColor === "white"
        ? "rgba(0,0,0,0.95)"
        : null;

  const outlineSize = outlineColor
    ? Math.max(3, Math.min(10, s.strokeWidth * 0.7))
    : 0;

  const outlineShadow = outlineColor
    ? buildOutlineShadow(outlineColor, outlineSize)
    : undefined;

  const dropShadow =
    activeResult.textShadow ??
    (s.shadow && s.shadow !== "none" ? s.shadow : undefined);

  // Gradient strategies use webkit fill — skip the outline shadow
  // (they conflict with -webkit-text-fill-color)
  const finalTextShadow = activeResult.webkitTextFillColor
    ? dropShadow
    : [outlineShadow, dropShadow].filter(Boolean).join(", ") || undefined;

  const isBgSlide = s.activeStrategy === "bg_slide";
  const letterSpacing = s.letterSpacing || "normal";

  // ── Typewriter: compute visibleChars for the JSX below ────
  // Done once here so both the outer opacity guard and the char
  // map share the exact same value.
  const typewriterVisibleChars =
    s.animation === "typewriter"
      ? Math.ceil(
          interpolate(
            frameInGroup,
            [entryStart, entryStart + word.length * 2],
            [0, word.length],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
        )
      : undefined;

  // ─────────────────────────────────────────────────────────
  // JSX
  // ─────────────────────────────────────────────────────────
  return (
    <span
      style={{
        display: "inline-block",
        position: "relative",
        // FIX: no zIndex:0 here — we must NOT create a stacking context
        // because the tape child uses DOM order (not z-index) to sit
        // behind the text wrapper.

        fontFamily: activeResult.fontFamily
          ? `'${activeResult.fontFamily}', serif`
          : `'${
              isAltFont && s.alternateFontFamily
                ? s.alternateFontFamily
                : s.fontFamily
            }', sans-serif`,

        fontSize,

        fontWeight:
          activeResult.fontWeight ??
          (isAltFont && s.alternateFontWeight
            ? s.alternateFontWeight
            : s.fontWeight),

        fontStyle: activeResult.fontStyle || s.fontStyle || "normal",

        color: activeResult.color,

        opacity: activeResult.opacity ?? opacity,

        transform: activeResult.transform || transform,

        transformOrigin,

        filter,

        textShadow: finalTextShadow,

        letterSpacing: activeResult.letterSpacing || letterSpacing,

        background: isBgSlide ? undefined : activeResult.background,

        backgroundClip: isBgSlide ? undefined : activeResult.backgroundClip,

        WebkitBackgroundClip: isBgSlide
          ? undefined
          : activeResult.webkitBackgroundClip,

        WebkitTextFillColor: isBgSlide
          ? undefined
          : activeResult.webkitTextFillColor,

        backgroundSize: isBgSlide ? undefined : activeResult.backgroundSize,

        backgroundPosition: isBgSlide
          ? undefined
          : activeResult.backgroundPosition,

        padding: isBgSlide
          ? `2px ${Math.round(baseSize * 0.28)}px`
          : activeResult.padding,

        borderRadius: isBgSlide
          ? (activeResult.bgSlideRadius ?? 8)
          : activeResult.borderRadius,

        borderBottom: activeResult.borderBottom,

        overflow: isBgSlide ? "hidden" : undefined,

        transition: "none",
        userSelect: "none",
      }}
    >
      {/*
       * ── Tape (extrude_3d) ─────────────────────────────────
       * FIX: Rendered FIRST in DOM order with NO zIndex.
       * The text wrapper below has position:relative + zIndex:1,
       * so it naturally stacks above this tape without any
       * zIndex:-1 tricks that break inside Remotion's render.
       */}
      {activeResult.showTape && (
        <span
          style={{
            position: "absolute",
            bottom: "0.0em",
            left: "-4%",
            width: "108%",
            height: activeResult.tapeHeight || 20,
            background: activeResult.tapeColor || "#FF2020",
            // NO zIndex here — DOM order handles layering
            borderRadius: s.pillRadius ?? 0,
          }}
        />
      )}

      {/*
       * ── Text content wrapper ──────────────────────────────
       * position:relative + zIndex:1 ensures this sits above
       * the tape span above regardless of stacking context.
       */}
      <span style={{ position: "relative", zIndex: 1 }}>
        {/*
         * ── Typewriter character reveal ─────────────────────
         * FIX: single code path — no duplicate displayWord
         * variable. typewriterVisibleChars is computed once above.
         * Each char manages its own opacity/scale; the outer span
         * is always fully opaque so there is no hard 0→1 snap.
         */}
        {s.animation === "typewriter"
          ? word.split("").map((char, i) => {
              if (i >= (typewriterVisibleChars ?? 0)) return null;

              const isLatest = i === (typewriterVisibleChars ?? 0) - 1;

              const charOpacity = isLatest
                ? interpolate(
                    frameInGroup,
                    [entryStart + i * 2, entryStart + i * 2 + 2],
                    [0, 1],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                  )
                : 1;

              const charScale = isLatest
                ? interpolate(
                    frameInGroup,
                    [entryStart + i * 2, entryStart + i * 2 + 2],
                    [0.8, 1],
                    {
                      easing: Easing.out(Easing.back(1.5)),
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    },
                  )
                : 1;

              return (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    opacity: charOpacity,
                    transform: `scale(${charScale})`,
                    whiteSpace: "pre",
                  }}
                >
                  {char}
                </span>
              );
            })
          : word}
      </span>

      {/* ── Underline ──────────────────────────────────────── */}
      {activeResult.showUnderline && (
        <span
          style={{
            position: "absolute",
            bottom: -4,
            left: 0,
            height: s.activeUnderlineHeight ?? 3,
            width: `${activeResult.underlineWidth}%`,
            background: s.activeUnderlineColor || "#FF6B35",
            borderRadius: 2,
            transition: "none",
          }}
        />
      )}

      {/* ── Cursor blink ───────────────────────────────────── */}
      {activeResult.showCursor && (
        <span
          style={{
            display: "inline-block",
            width: "0.48em",
            height: "1em",
            background: s.cursorColor || "#FFD700",
            verticalAlign: "text-bottom",
            marginLeft: 4,
            opacity: Math.sin(frameInGroup * 0.28) > 0 ? 1 : 0,
          }}
        />
      )}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────
// FLOATING KEYWORD OVERLAY
// Renders peak3 words that have floatKeyword=true as a separate
// cinematic overlay — positioned above the main caption line,
// larger, with its own punch-in animation. Creates the "hero word"
// effect seen in premium CapCut/After Effects edits.
// ─────────────────────────────────────────────────────────────
const FloatingKeyword: React.FC<{
  word: string;
  style: StyleConfig;
  fps: number;
  colorOverride: string | null;
  emphasisScale: number;
  animationType?: string;
}> = ({ word, style: s, fps, colorOverride, emphasisScale, animationType }) => {
  const frame = useCurrentFrame();

  // Punch-in spring: explosive entry
  const entrySpring = spring({
    frame,
    fps,
    config: { damping: 20, stiffness: 480, mass: 0.45 },
  });

  // Scale: starts 2.4x → settles to emphasisScale × base
  const scaleVal = interpolate(entrySpring, [0, 1], [2.4, 1.0], {
    extrapolateRight: "clamp",
  });

  // Opacity: flash in instantly
  const opacityVal = interpolate(frame, [0, 3], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Vertical shake on entry — impact feel
  const shakeY =
    frame < 8
      ? interpolate(frame, [0, 3, 5, 7, 8], [0, -12, 6, -3, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

  const displayWord = s.uppercase ? word.toUpperCase() : word;
  const floatFontSize = s.fontSize * emphasisScale * 1.1;

  const color = colorOverride || s.activeColor || "#FFFFFF";

  const outlineColor =
    s.strokeWidth > 0 && s.strokeColor !== "transparent"
      ? s.strokeColor
      : "rgba(0,0,0,0.95)";
  const outlineSize = Math.max(4, Math.min(14, s.strokeWidth * 0.9));
  const outlineShadow = buildOutlineShadow(outlineColor, outlineSize);

  // Glow halo behind the floating word — cinematic depth
  const glowColor = color.replace(/#([0-9a-f]{6})/i, (_, hex) => {
    return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},0.45)`;
  });
  const glowShadow = `0 0 40px ${glowColor}, 0 0 80px ${glowColor}`;
  const finalShadow = [outlineShadow, glowShadow].filter(Boolean).join(", ");

  return (
    <div
      style={{
        position: "absolute",
        // Float above the main caption area — top 30% of frame for dramatic effect
        top: "28%",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 25,
        pointerEvents: "none",
        transform: `scale(${scaleVal}) translateY(${shakeY}px)`,
        opacity: opacityVal,
        transformOrigin: "center center",
      }}
    >
      <span
        style={{
          fontFamily: `'${s.fontFamily}', sans-serif`,
          fontWeight: s.fontWeight,
          fontSize: floatFontSize,
          color,
          textShadow: finalShadow,
          textTransform: s.uppercase ? "uppercase" : "none",
          letterSpacing: s.letterSpacing || "normal",
          userSelect: "none",
          display: "inline-block",
          // Subtle rotation for handcrafted feel
          rotate: animationType === "slam_down" ? "-2deg" : "1.5deg",
        }}
      >
        {displayWord}
      </span>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// B-ROLL OVERLAY
// ─────────────────────────────────────────────────────────────
const BrollOverlay: React.FC<{
  segment: BrollSegment;
  fps: number;
}> = ({ segment, fps }) => {
  const { videoUrl, startSec, durationSec } = segment;
  const startFrame = Math.floor(startSec * fps);
  const durationFrames = Math.ceil(durationSec * fps);
  const FADE_FRAMES = Math.floor(0.3 * fps);

  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <BrollInner
        videoUrl={videoUrl}
        durationFrames={durationFrames}
        fadeFrames={FADE_FRAMES}
      />
    </Sequence>
  );
};

const BrollInner: React.FC<{
  videoUrl: string;
  durationFrames: number;
  fadeFrames: number;
}> = ({ videoUrl, durationFrames, fadeFrames }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, fadeFrames, durationFrames - fadeFrames, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ opacity, zIndex: 10 }}>
      <OffthreadVideo
        src={videoUrl}
        muted={true}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
export const CaptionedVideo: React.FC<Props> = ({
  videoSrc,
  words,
  style,
  fps,
  clipDurationSecs = 60,
  emojiOverlays = [],
  brollSegments = [],
  splitTimeline = [],
  emphasisEvents = [],
  titleEnabled,
  titleText,
  titleStyle,
  titlePosition,
}) => {
  const frame = useCurrentFrame();
  const t = frame / fps;

  if (t > clipDurationSecs) return null;

  const activeIdx = words.findIndex((w) => t >= w.startSec && t < w.endSec);
  const allDone = words.length > 0 && t > words[words.length - 1].endSec + 0.4;

  let lastStartedIdx = -1;
  for (let i = 0; i < words.length; i++) {
    if (t >= words[i].startSec) lastStartedIdx = i;
    else break;
  }
  const effectiveActiveIdx = activeIdx >= 0 ? activeIdx : lastStartedIdx;

  if (allDone || effectiveActiveIdx < 0) {
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={resolveVideoSrc(videoSrc)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        {brollSegments.map((seg, i) => (
          <BrollOverlay key={i} segment={seg} fps={fps} />
        ))}
      </AbsoluteFill>
    );
  }

  const wordsPerGroup = style.wordsPerLine || 2;
  const totalGroups = Math.ceil(words.length / wordsPerGroup);
  const currentGroupIndex = Math.floor(effectiveActiveIdx / wordsPerGroup);
  const groupStart = currentGroupIndex * wordsPerGroup;
  const groupWords = words.slice(groupStart, groupStart + wordsPerGroup);

  const groupFirstWord = words[groupStart];
  const frameInGroup = Math.max(
    0,
    frame - Math.floor(groupFirstWord.startSec * fps),
  );

  const activeWordIndex = activeIdx >= 0 ? activeIdx - groupStart : -1;

  const isInSplitMoment =
    splitTimeline.length > 0 &&
    splitTimeline.some((seg) => t >= seg.startSec && t < seg.endSec);

  const effectiveLayout = isInSplitMoment ? "center" : style.layout;

  // ── Floating keyword — peak3 words that should "lift" above the line ──
  // Find the active word's emphasis event and check if it wants to float
  const activeWordForFloat =
    effectiveActiveIdx >= 0 ? words[effectiveActiveIdx] : null;
  const floatEmphasisEntry = activeWordForFloat
    ? emphasisEvents.find(
        (e) =>
          e.wordIndex === activeWordForFloat.index && e.floatKeyword === true,
      )
    : null;
  const showFloatingKeyword = !!floatEmphasisEntry && effectiveActiveIdx >= 0;

  // When a floating keyword is showing, nudge the caption group down slightly
  // so the two layers don't overlap — creates clear visual hierarchy
  const captionYOffset = showFloatingKeyword ? 40 : 0;

  // Alternate caption X position between groups for dynamic rhythm
  // Even groups: slightly left-of-center; odd groups: slightly right-of-center
  // This breaks the "static subtitle" feel and adds CapCut-style composition
  const groupPositionDrift =
    style.layout === "bottom-center" && !isInSplitMoment
      ? currentGroupIndex % 3 === 0
        ? -18 // slight left
        : currentGroupIndex % 3 === 1
          ? 18 // slight right
          : 0 // centered
      : 0;

  const layoutStyle = getLayoutPosition(
    effectiveLayout,
    isInSplitMoment ? undefined : style,
  );

  // Apply dynamic offsets on top of base layout
  const dynamicLayoutStyle: React.CSSProperties = {
    ...layoutStyle,
    transform:
      [
        layoutStyle.transform,
        captionYOffset !== 0 ? `translateY(${captionYOffset}px)` : "",
        groupPositionDrift !== 0 ? `translateX(${groupPositionDrift}px)` : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
  const flexAlign = getFlexAlign(effectiveLayout);
  const alignItems = getAlignItems(effectiveLayout);

  const ICON_DURATION = 2.5;
  const activeOverlays = emojiOverlays.filter(
    (o) => t >= o.atSec && t < o.atSec + ICON_DURATION,
  );

  const iconAnimations = activeOverlays.map((o) => {
    const elapsed = t - o.atSec;
    const progress = elapsed / ICON_DURATION;
    const popProgress = Math.min(1, elapsed / 0.25);
    const fadeProgress = progress > 0.7 ? (progress - 0.7) / 0.3 : 0;
    const scale = 0.3 + 0.7 * Math.min(1, popProgress * 1.2);
    const opacity = popProgress - fadeProgress;
    return { overlay: o, scale, opacity };
  });

  const hasBox =
    style.bgBoxColor &&
    style.bgBoxColor !== "rgba(0,0,0,0.0)" &&
    style.bgBoxColor !== "transparent";

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo
        src={resolveVideoSrc(videoSrc)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {brollSegments.map((seg, i) => (
        <BrollOverlay key={i} segment={seg} fps={fps} />
      ))}

      {titleEnabled &&
        titleText &&
        titleStyle &&
        (() => {
          const ts = titleStyle as any;
          const displayText = ts.uppercase
            ? titleText.toUpperCase()
            : titleText;

          const hasGradient = !!ts._gradientOverride;
          const gradient = ts._gradientOverride ?? "";

          const hasBox =
            ts.backgroundColor &&
            ts.backgroundColor !== "transparent" &&
            !ts.backgroundColor.startsWith("rgba(0,0,0,0)");

          // Resolve borderRadius from backgroundShape
          const shape = ts.backgroundShape || "none";
          let computedRadius: number = ts.borderRadius ?? 0;
          if (shape === "pill") computedRadius = 100;
          if (shape === "tape")
            computedRadius = Math.min(6, ts.borderRadius ?? 4);
          if (shape === "message") computedRadius = ts.borderRadius ?? 20;
          if (shape === "rectangle") computedRadius = ts.borderRadius ?? 10;

          // Remotion canvas is 1080px tall — fontSize is already in canvas-px units
          const fontSize = Math.min(ts.fontSize || 72, 96);

          const textStyle: React.CSSProperties = {
            fontFamily: `'${ts.fontFamily}', sans-serif`,
            fontWeight: ts.fontWeight,
            fontStyle: ts.fontStyle || "normal",
            textTransform: ts.uppercase ? "uppercase" : "none",
            letterSpacing: ts.letterSpacing || "normal",
            fontSize,
            lineHeight: 1.15,
            color: hasGradient ? "transparent" : ts.textColor,
            textShadow:
              ts.shadow && ts.shadow !== "none" ? ts.shadow : undefined,
            WebkitTextStrokeWidth: ts.strokeWidth ? `${ts.strokeWidth}px` : "0",
            WebkitTextStrokeColor: ts.strokeColor || "transparent",
            background: hasGradient ? gradient : "transparent",
            backgroundClip: hasGradient ? "text" : "border-box",
            WebkitBackgroundClip: hasGradient ? "text" : "unset",
            WebkitTextFillColor: hasGradient ? "transparent" : "unset",
            textAlign: "center",
            wordBreak: "break-word",
            display: "block",
          };

          const containerStyle: React.CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            background: hasBox ? ts.backgroundColor : "transparent",
            padding: hasBox ? ts.padding || "16px 36px" : "0",
            borderRadius: hasBox ? computedRadius : 0,
            boxShadow: ts.boxShadow || undefined,
          };

          return (
            <div
              style={{
                position: "absolute",
                zIndex: 15,
                width: "100%",
                left: 0,
                display: "flex",
                justifyContent: "center",
                top:
                  titlePosition === "top"
                    ? 150
                    : titlePosition === "center"
                      ? "50%"
                      : "auto",
                bottom: titlePosition === "bottom" ? 200 : "auto",
                transform:
                  titlePosition === "center" ? "translateY(-50%)" : "none",
              }}
            >
              <div style={containerStyle}>
                <span style={textStyle}>{displayText}</span>

                {/* Message bubble tail */}
                {shape === "message" && hasBox && (
                  <span
                    style={{
                      position: "absolute",
                      bottom: -14,
                      left: 32,
                      width: 0,
                      height: 0,
                      borderLeft: "10px solid transparent",
                      borderRight: "10px solid transparent",
                      borderTop: `14px solid ${ts.backgroundColor}`,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })()}

      {/* Floating keyword — peak3 impact words that lift above the caption line */}
      {showFloatingKeyword && activeWordForFloat && floatEmphasisEntry && (
        <Sequence
          from={Math.floor(activeWordForFloat.startSec * fps)}
          durationInFrames={Math.max(
            1,
            Math.ceil(
              (activeWordForFloat.endSec - activeWordForFloat.startSec + 0.35) *
                fps,
            ),
          )}
        >
          <FloatingKeyword
            word={activeWordForFloat.word}
            style={style}
            fps={fps}
            colorOverride={floatEmphasisEntry.colorOverride}
            emphasisScale={floatEmphasisEntry.emphasisScale ?? 1.55}
            animationType={floatEmphasisEntry.animationType}
          />
        </Sequence>
      )}

      {/* Caption overlay */}
      <div
        style={{
          position: "absolute",
          ...dynamicLayoutStyle,
          zIndex: 10,
        }}
      >
        <div
          style={{
            position: "relative",
            padding: style.padding || "20px 30px",
            borderRadius: style.borderRadius ?? 12,
            border: style.border,
            backdropFilter: style.backdropBlur
              ? `blur(${style.backdropBlur}px)`
              : undefined,
          }}
        >
          {hasBox && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: style.bgBoxColor,
                borderRadius: style.borderRadius ?? 12,
                border: style.border,
              }}
            />
          )}

          {/* Icon overlays */}
          {iconAnimations.map(({ overlay, scale, opacity }, idx) => {
            const iconSize = overlay.size ?? 100;
            const isEmoji = !!overlay.emoji;
            return (
              <div
                key={`icon-${idx}-${overlay.atSec}`}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: -(iconSize + 12),
                  transform: `translateX(-50%) scale(${scale})`,
                  opacity: Math.max(0, Math.min(1, opacity)),
                  zIndex: 20,
                  pointerEvents: "none",
                  transformOrigin: "center bottom",
                }}
              >
                {isEmoji ? (
                  <span
                    style={{
                      fontSize: iconSize,
                      lineHeight: 1,
                      display: "block",
                      textAlign: "center",
                      filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.7))",
                      userSelect: "none",
                    }}
                  >
                    {overlay.emoji}
                  </span>
                ) : (
                  <img
                    src={staticFile(`icons/${overlay.icon}`)}
                    alt=""
                    style={{
                      width: iconSize,
                      height: iconSize,
                      display: "block",
                      filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.8))",
                      objectFit: "contain",
                    }}
                  />
                )}
              </div>
            );
          })}

          <div
            style={{
              position: "relative",
              display: "flex",
              flexWrap: "wrap",
              columnGap: `${style.fontSize * 0.22}px`,
              rowGap: Math.round(
                (style.lineSpacing ?? 1.15) * (style.fontSize * 0.95) * 0.28,
              ),
              justifyContent: flexAlign,
              alignItems: "center",
            }}
          >
            {groupWords.map((w, i) => {
              const displayWord = style.uppercase
                ? w.word.toUpperCase()
                : w.word;
              const isAltFont =
                style.activeStrategy === "dual_font_active" && i % 2 === 1;

              const emphasisEntry = emphasisEvents.find(
                (e) => e.wordIndex === w.index,
              );
              const emphasisColorOverride =
                emphasisEntry?.colorOverride ?? null;

              return (
                <AnimatedWord
                  key={`${currentGroupIndex}-${i}`}
                  word={
                    isAltFont && style.alternateUppercase
                      ? displayWord.toUpperCase()
                      : displayWord
                  }
                  isActive={i === activeWordIndex}
                  index={i}
                  captionStyle={style}
                  frameInGroup={frameInGroup}
                  fps={fps}
                  isAltFont={isAltFont}
                  totalWords={groupWords.length}
                  emphasisColorOverride={emphasisColorOverride}
                  emphasisScale={emphasisEntry?.emphasisScale ?? 1.0}
                  animationType={emphasisEntry?.animationType}
                />
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default CaptionedVideo;
