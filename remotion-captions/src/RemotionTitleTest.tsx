import React, { useMemo, useState } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

type TitleStyle = {
  name: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  uppercase?: boolean;
  textColor: string;
  backgroundColor?: string;
  padding?: string;
  borderRadius?: number;
  boxShadow?: string;
  shadow?: string;
  letterSpacing?: string;
  fontStyle?: string;
  strokeColor?: string;
  strokeWidth?: number;
  animation?: "fade_in" | "slide_up" | "scale" | "glitch";
  _gradientOverride?: string;
};

const TITLE_STYLES: Record<string, TitleStyle> = {
  clean_sans: {
    name: "clean_sans",
    fontFamily: "Montserrat",
    fontSize: 72,
    fontWeight: 700,
    textColor: "black",
    backgroundColor: "white",
    padding: "12px 28px",
    borderRadius: 8,
    boxShadow: "0 2px 24px rgba(0,0,0,0.55)",
    letterSpacing: "-0.5px",
    animation: "fade_in",
  },
  pure_white: {
    name: "pure_white",
    fontFamily: "Poppins",
    fontSize: 68,
    fontWeight: 800,
    textColor: "#FFFFFF",
    backgroundColor: "transparent",
    shadow: "0 1px 30px rgba(0,0,0,0.7)",
    letterSpacing: "-1px",
    animation: "fade_in",
  },
  blockbuster: {
    name: "blockbuster",
    fontFamily: "Oswald",
    fontSize: 92,
    fontWeight: 700,
    uppercase: true,
    textColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 6,
    backgroundColor: "transparent",
    shadow: "0 4px 0 #8B0000, 0 8px 32px rgba(139,0,0,0.5)",
    letterSpacing: "8px",
    animation: "scale",
  },
  gradient_text: {
    name: "gradient_text",
    fontFamily: "Montserrat",
    fontSize: 80,
    fontWeight: 700,
    textColor: "#FFFFFF",
    backgroundColor: "black",
    boxShadow: "0 4px 32px rgba(0,0,0,0.6)",
    letterSpacing: "-1px",
    animation: "fade_in",
    _gradientOverride:
      "linear-gradient(135deg, #FF6B6B 0%, #FFE66D 40%, #4ECDC4 80%, #44A8B3 100%)",
  },
  clean_outline: {
    name: "clean_outline",
    fontFamily: "Bebas Neue",
    fontSize: 90,
    fontWeight: 400,
    uppercase: true,
    textColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 10,
    backgroundColor: "transparent",
    shadow: "0 4px 20px rgba(0,0,0,0.6)",
    letterSpacing: "4px",
    animation: "scale",
  },
  premium_pink_purple: {
    name: "premium_pink_purple",
    fontFamily: "Montserrat",
    fontSize: 82,
    fontWeight: 900,
    uppercase: true,
    textColor: "#FFFFFF",
    strokeColor: "rgba(10,10,18,0.9)",
    strokeWidth: 4,
    backgroundColor: "transparent",
    shadow: "0 0 28px rgba(255,79,216,0.45), 0 12px 40px rgba(0,0,0,0.76)",
    letterSpacing: "1px",
    animation: "scale",
    _gradientOverride:
      "linear-gradient(115deg, #FFE1F7 0%, #FF4FD8 20%, #8B5CFF 52%, #5D2BFF 76%, #F5D5FF 100%)",
  },
  aurora_cyan_violet: {
    name: "aurora_cyan_violet",
    fontFamily: "Poppins",
    fontSize: 78,
    fontWeight: 900,
    textColor: "#FFFFFF",
    strokeColor: "rgba(3,8,22,0.86)",
    strokeWidth: 3,
    backgroundColor: "transparent",
    shadow: "0 0 26px rgba(54,232,255,0.45), 0 0 52px rgba(139,92,255,0.25), 0 10px 34px rgba(0,0,0,0.68)",
    letterSpacing: "-0.5px",
    animation: "fade_in",
    _gradientOverride:
      "linear-gradient(108deg, #E5FDFF 0%, #36E8FF 24%, #8B5CFF 54%, #FF4FD8 84%, #FFFFFF 100%)",
  },
  neon_orange_pink: {
    name: "neon_orange_pink",
    fontFamily: "Oswald",
    fontSize: 88,
    fontWeight: 800,
    uppercase: true,
    textColor: "#FFFFFF",
    strokeColor: "#12040B",
    strokeWidth: 5,
    backgroundColor: "transparent",
    shadow: "0 7px 0 rgba(24,4,12,0.9), 0 0 30px rgba(255,78,128,0.42), 0 12px 40px rgba(0,0,0,0.7)",
    letterSpacing: "4px",
    animation: "scale",
    _gradientOverride:
      "linear-gradient(112deg, #FFF0B8 0%, #FFB347 20%, #FF5F6D 48%, #FF2FB2 78%, #FFE0F3 100%)",
  },
};

const hasVisibleBox = (style: TitleStyle) =>
  !!style.backgroundColor &&
  style.backgroundColor !== "transparent" &&
  !style.backgroundColor.startsWith("rgba(0,0,0,0");

export const RemotionTitleTest = () => {
  const [styleName, setStyleName] = useState("clean_sans");
  const style = TITLE_STYLES[styleName] ?? TITLE_STYLES.clean_sans;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  const animationStyle = useMemo<React.CSSProperties>(() => {
    switch (style.animation) {
      case "slide_up":
        return {
          opacity: interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(frame, [0, 18], [38, 0], {
            extrapolateRight: "clamp",
          })}px)`,
        };
      case "scale":
        return { transform: `scale(${0.86 + entrance * 0.14})`, opacity: entrance };
      case "glitch":
        return {
          transform: `translate(${frame % 8 < 2 ? -4 : 0}px, ${frame % 10 < 2 ? 3 : 0}px)`,
          opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" }),
        };
      default:
        return {
          opacity: interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" }),
        };
    }
  }, [entrance, frame, style.animation]);

  const displayText = style.uppercase ? "Finish What Matters".toUpperCase() : "Finish What Matters";
  const hasGradient = !!style._gradientOverride;
  const hasBox = hasVisibleBox(style);

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        background:
          "linear-gradient(180deg, #172033 0%, #4a5365 52%, #d8c6aa 100%)",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          zIndex: 10,
          background: "rgba(0,0,0,0.78)",
          padding: "10px 15px",
          borderRadius: 8,
          color: "white",
          fontFamily: "sans-serif",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <label htmlFor="titleStyleSelect" style={{ fontSize: 18 }}>
          Title Style:
        </label>
        <select
          id="titleStyleSelect"
          value={styleName}
          onChange={(event) => setStyleName(event.target.value)}
          style={{ fontSize: 16, padding: "4px 8px", borderRadius: 4 }}
        >
          {Object.keys(TITLE_STYLES).map((key) => (
            <option key={key} value={key}>
              {TITLE_STYLES[key].name}
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          ...animationStyle,
          background: hasBox ? style.backgroundColor : "transparent",
          borderRadius: hasBox ? style.borderRadius ?? 0 : 0,
          boxShadow: style.boxShadow,
          color: hasGradient ? "transparent" : style.textColor,
          fontFamily: `'${style.fontFamily}', sans-serif`,
          fontSize: Math.min(style.fontSize || 72, 92),
          fontStyle: style.fontStyle || "normal",
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing || "normal",
          lineHeight: 1.05,
          maxWidth: 960,
          padding: hasBox ? style.padding || "16px 36px" : 0,
          textAlign: "center",
          textShadow: style.shadow,
          WebkitBackgroundClip: hasGradient ? "text" : undefined,
          backgroundClip: hasGradient ? "text" : undefined,
          backgroundImage: hasGradient ? style._gradientOverride : undefined,
          WebkitTextStrokeColor: style.strokeColor || "transparent",
          WebkitTextStrokeWidth: style.strokeWidth ? `${style.strokeWidth}px` : undefined,
        }}
      >
        {displayText}
      </div>
    </AbsoluteFill>
  );
};
