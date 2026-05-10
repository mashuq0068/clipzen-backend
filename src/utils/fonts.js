/* eslint-disable no-undef */
const { registerFont } = require("canvas");
const path = require("path");

function initFonts() {
  registerFont(
     path.resolve(__dirname, "../assets/fonts/montserrat.ttf"),
    {
      family: "Montserrat",
    }
  );
}

module.exports = { initFonts };