// Renders assets/icon.svg to a 1024x1024 PNG for `npx tauri icon`.
import sharp from "sharp";

await sharp("assets/icon.svg")
  .resize(1024, 1024)
  .png()
  .toFile("assets/icon.png");

console.log("wrote assets/icon.png");
