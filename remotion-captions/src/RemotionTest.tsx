// Root.tsx or the file where RemotionTest lives
import React, { useState, useMemo } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
// Import from the original caption module
import {
  AnimatedWord,
  getLayoutPosition,
  getAlignItems,
  getFlexAlign,
  type StyleConfig,
} from "./CaptionedVideo"; // adjust path if needed
// Sample words generator
const SAMPLE_TEXT =
  "এটি আপনার ক্যাপশন স্টাইল নির্বাচন-এর একটি প্রিভিউ। প্রতিটি শব্দ ক্রমানুসারে হাইলাইট হবে যাতে আপনি দেখতে পারেন এটি কেমন দেখায়।";
  
const WORD_DURATION = 0.5; // each word appears for 0.5 seconds
const PREVIEW_FPS = 30;
// ─────────────────────────────────────────────────────────────
// CAPTION_STYLES.ts  —  all original + 5 new styles
// ─────────────────────────────────────────────────────────────
//
// NEW GOOGLE FONTS NEEDED — add to your remotion Root / HTML head:
//
// import { loadFont as loadOswald }         from "@remotion/google-fonts/Oswald";
// import { loadFont as loadCourierPrime }   from "@remotion/google-fonts/CourierPrime";
// import { loadFont as loadPermanentMarker} from "@remotion/google-fonts/PermanentMarker";
// import { loadFont as loadPlayfair }       from "@remotion/google-fonts/PlayfairDisplay";
// import { loadFont as loadRussoOne }       from "@remotion/google-fonts/RussoOne";
//
// loadOswald();
// loadCourierPrime();
// loadPermanentMarker();
// loadPlayfair();
// loadRussoOne();
//
// ─────────────────────────────────────────────────────────────

export const CAPTION_STYLES = {
  ticker: {
    name: "ticker",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#39E75F",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 62,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "normal",
  },
  flip_board: {
    name: "flip_board",
    layout: "bottom-center",
    textColor: "white",
    strokeColor: "transparent",
    strokeWidth: 5,
    bgBoxColor: "transparent",
    fontSize: 62,
    animation: "deco_drop",
    fontFamily: "Montserrat",
    fontWeight: 800,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "none",
    activeStrategy: "bg_pill",
    activeBg: "#FA5E28",
    activeTextColor: "#FFFFFF",
    pillRadius: 10,
    activeColor: "#FA5E28",
  },
  extrude_3d: {
    name: "extrude_3d",
    layout: "bottom-center",
    activeColor: "#FFFFFF",
    textColor: "#FFFFFF",
    activeTextColor: "#FFFFFF",
    activeBg: "#3c57edff",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "none",
    fontSize: 62,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
    activeStrategy: "extrude_3d",
    extrudeDepth: 20,
  },
  bebus: {
    name: "bebus",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#d369f3",
    strokeColor: "#000000",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "deco_drop",
    letterSpacing: "0.09em",
    fontSize: 94,
    fontFamily: "Bebas Neue",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
  },
  audio_wide: {
    name: "audio_wide",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#b5ee7d",
    strokeColor: "#000000",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 64,
    fontFamily: "Audiowide",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "normal",
  },
  bangers: {
    name: "bangers",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#49e7ed",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "deco_drop",
    fontSize: 80,
    fontFamily: "Bangers",
    fontWeight: 400,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "10px",
  },
  lobster: {
    name: "lobster",
    layout: "bottom-center",
    textColor: "white",
    activeColor: "#bde566",
    strokeColor: "#000000",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    fontSize: 70,
    fontFamily: "Lobster",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "0px",
    animation: "none",
  },
  tricky: {
    name: "tricky",
    layout: "bottom-center",
    textColor: "#ffff",
    activeColor: "#e6d978",
    strokeColor: "#336134",
    strokeWidth: 15,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 70,
    fontFamily: "Nano Sans",
    fontWeight: 900,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  simple: {
    name: "simple",
    layout: "bottom-center",
    textColor: "#f0f4d9",
    activeColor: "#f0f4d9",
    strokeColor: "black",
    strokeWidth: 8,
    bgBoxColor: "rgba(208, 198, 198, 0)",
    animation: "none",
    fontSize: 70,
    fontFamily: "Poppins",
    fontWeight: 900,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  simple_smart: {
    name: "simple_smart",
    layout: "bottom-center",
    textColor: "#f0f4d9",
    activeColor: "#f0f4d9",
    strokeColor: "#5c1ed0",
    strokeWidth: 8,
    bgBoxColor: "transparent",
    animation: "none",
    fontSize: 70,
    fontFamily: "Montserrat",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 16px rgba(0,0,0,0.8)",
    letterSpacing: "3px",
  },
  neon_night: {
    name: "neon_night",
    layout: "bottom-center",
    textColor: "#65fbfb",
    activeColor: "#ea80ea",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "transparent",
    animation: "glitch",
    fontSize: 76,
    fontFamily: "Oswald",
    fontWeight: 900,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 0 20px #00FFFF, 0 0 40px #00FFFF88",
    letterSpacing: "4px",
    activeStrategy: "neon_glow",
  },
  typewrite: {
    name: "typewrite",
    layout: "bottom-center",
    textColor: "#f0b128",
    activeColor: "#f0b128",
    strokeColor: "transparent",
    strokeWidth: 0,
    bgBoxColor: "black",
    animation: "typewriter",
    fontSize: 54,
    fontFamily: "Courier Prime",
    fontWeight: 700,
    uppercase: false,
    wordsPerLine: 4,
    lineSpacing: 0.6,
    shadow: "0 0 10px rgba(0,255,65,0.4)",
    letterSpacing: "2px",
    activeStrategy: "cursor_blink",
    cursorColor: "#f0b128",
    borderRadius: 4,
    padding: "20px 30px",
    border: "1px solid rgba(0,255,65,0.3)",
  },
  box: {
    name: "box",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFD700",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "rgba(177, 113, 229, 0.72)",
    animation: "none",
    fontSize: 62,
    fontFamily: "Poppins",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 4,
    lineSpacing: 0.6,
    shadow: "none",
    borderRadius: 8,
    padding: "18px 28px",
  },
  box_glass: {
    name: "box_glass",
    layout: "bottom-center",
    textColor: "#F5F0E8",
    activeColor: "#f6d56c",
    strokeColor: "black",
    strokeWidth: 6,
    bgBoxColor: "#7d7d7d",
    backdropBlur: 14,
    border: "1px solid rgba(255, 255, 255, 0.18)",
    animation: "none",
    fontSize: 62,
    fontFamily: "Poppins",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 6,
    lineSpacing: 0.6,
    shadow: "none",
    borderRadius: 12,
    padding: "18px 28px",
  },
  street_tag: {
    name: "street_tag",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFFF00",
    strokeColor: "black",
    strokeWidth: 10,
    bgBoxColor: "transparent",
    animation: "swing",
    fontSize: 80,
    fontFamily: "Lobster",
    fontWeight: 800,
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.7,
    shadow: "3px 5px 0px #000, 6px 10px 0px rgba(0,0,0,0.3)",
    letterSpacing: "3px",
    activeStrategy: "bg_pill",
    activeBg: "#FF2D20",
    activeTextColor: "#FFFFFF",
    pillRadius: 4,
  },
  cinematic: {
    name: "cinematic",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFD700",
    strokeColor: "#000000",
    strokeWidth: 2,
    bgBoxColor: "transparent",
    animation: "blur_in",
    fontSize: 76,
    fontFamily: "Playfair Display",
    fontWeight: 900,
    fontStyle: "italic",
    uppercase: false,
    wordsPerLine: 3,
    lineSpacing: 0.6,
    shadow: "0 10px 40px rgba(0,0,0,0.9)",
    letterSpacing: "4px",
    activeStrategy: "shimmer",
    gradient:
      "linear-gradient(90deg, #FFF8DC 0%, #FFD54A 30%, #F4B400 50%, #FFD54A 70%, #FFF8DC 100%)",
  },
  retro_wave: {
    name: "retro_wave",
    layout: "bottom-center",
    textColor: "#C084FC",
    activeColor: "#F472B6",
    strokeColor: "#7631dd",
    strokeWidth: 13,
    bgBoxColor: "transparent",
    animation: "scale",
    fontSize: 74,
    fontFamily: "Russo One",
    fontWeight: 400,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 0px #4C1D95, 0 8px 20px rgba(76,29,149,0.7)",
    letterSpacing: "5px",
  },
  hard_punch: {
    name: "hard_punch",
    layout: "bottom-center",
    textColor: "#FFFFFF",
    activeColor: "#FFE600",
    strokeColor: "#000000",
    strokeWidth: 10,
    bgBoxColor: "transparent",
    animation: "zoom_punch",
    fontSize: 80,
    fontFamily: "Oswald",
    fontWeight: 700,
    uppercase: true,
    wordsPerLine: 3,
    lineSpacing: 0.5,
    shadow: "0 4px 20px rgba(0,0,0,0.9)",
    letterSpacing: "3px",
  },
};

function buildSampleWords() {
  const tokens = SAMPLE_TEXT.split(" ");
  let cursor = 0;
  return tokens.map((word, idx) => {
    const start = cursor;
    const end = start + WORD_DURATION;
    cursor = end + 0.05;
    return {
      word,
      startSec: start,
      endSec: end,
      index: idx,
    };
  });
} // unchanged

// ── The preview composable ─────────────────────────────
const PreviewCaptions: React.FC<{
  style: StyleConfig;
  words: { word: string; startSec: number; endSec: number; index: number }[];
  fps: number;
}> = ({ style, words, fps }) => {
  const frame = useCurrentFrame();
  const t = frame / fps;
  const totalDuration = words.length * (WORD_DURATION + 0.05);
  if (t > totalDuration) return null;

  const activeIdx = words.findIndex((w) => t >= w.startSec && t < w.endSec);
  if (activeIdx < 0) return <AbsoluteFill style={{ background: "black" }} />;

  const wordsPerGroup = style.wordsPerLine || 2;
  const totalGroups = Math.ceil(words.length / wordsPerGroup);
  const currentGroupIndex = Math.floor(activeIdx / wordsPerGroup);
  const groupStart = currentGroupIndex * wordsPerGroup;
  const groupWords = words.slice(groupStart, groupStart + wordsPerGroup);
  const groupFirstWord = words[groupStart];
  const frameInGroup = Math.max(
    0,
    frame - Math.floor(groupFirstWord.startSec * fps),
  );
  const activeWordIndex = activeIdx - groupStart;
  const layoutStyle = getLayoutPosition(style.layout);
  const flexAlign = getFlexAlign(style.layout);
  const alignItems = getAlignItems(style.layout);

  const hasBox =
    style.bgBoxColor &&
    style.bgBoxColor !== "rgba(0,0,0,0.0)" &&
    style.bgBoxColor !== "transparent";

  return (
    <AbsoluteFill style={{ background: "#948f8f", overflow: "hidden" }}>
      <div style={{ position: "absolute", ...layoutStyle, zIndex: 10 }}>
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
          <div
            style={{
              position: "relative",
              display: "flex",
              flexWrap: "wrap",
              columnGap: `${style.fontSize * 0.18}px`,
              rowGap:
                style.activeStrategy === "highlight_box"
                  ? Math.round(
                      (style.lineSpacing ?? 1.15) *
                        (style.fontSize * 0.95) *
                        0.35,
                    )
                  : Math.round(
                      (style.lineSpacing ?? 1.15) *
                        (style.fontSize * 0.95) *
                        0.28,
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
                  emphasisColorOverride={null}
                />
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── The Exported Test Composition ─────────────────────────
export const RemotionTest = () => {
  const [styleName, setStyleName] = useState("ticker");
  const selectedStyle =
    CAPTION_STYLES[styleName as keyof typeof CAPTION_STYLES];
  const sampleWords = useMemo(() => buildSampleWords(), []);

  return (
    <AbsoluteFill style={{ background: "#948f8f" }}>
      {/* Dropdown overlay */}
      <div
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          zIndex: 100,
          background: "rgba(0,0,0,0.8)",
          padding: "10px 15px",
          borderRadius: 8,
          color: "white",
          fontFamily: "sans-serif",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <label htmlFor="styleSelect" style={{ fontSize: 18 }}>
          Caption Style:
        </label>
        <select
          id="styleSelect"
          value={styleName}
          onChange={(e) => setStyleName(e.target.value)}
          style={{ fontSize: 16, padding: "4px 8px", borderRadius: 4 }}
        >
          {Object.keys(CAPTION_STYLES).map((key) => (
            <option key={key} value={key}>
              {CAPTION_STYLES[key as keyof typeof CAPTION_STYLES].name}
            </option>
          ))}
        </select>
      </div>

      {/* Caption preview */}
      <PreviewCaptions
        style={selectedStyle}
        words={sampleWords}
        fps={PREVIEW_FPS}
      />
    </AbsoluteFill>
  );
};
