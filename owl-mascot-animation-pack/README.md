# Owl Mascot Animation Pack

Professional minimalist pixel-style owl animations for an AI chat + cybersecurity UI.

## Contents

- `sprites/`: horizontal transparent PNG sprite sheets.
- `frames/`: individual transparent PNG frames.
- `previews/`: GIF previews on a warm off-white background.
- `manifest.json`: machine-readable metadata for another AI or engineer.

## States

- `idle`: slow blink and tiny breathing motion.
- `waiting`: eye scan and cyan core pulse.
- `thinking`: cyan thinking pixels and core pulse.
- `success`: small lift and brightened eyes.
- `warning`: amber security alert pulse.
- `error`: short shake with red/amber recovery.

## CSS Sprite Example

```css
.owlMascot {
  width: 64px;
  height: 64px;
  background-image: url("./sprites/owl-thinking-sprite.png");
  background-size: 384px 64px;
  image-rendering: pixelated;
  animation: owlThinking 780ms steps(6) infinite;
}

@keyframes owlThinking {
  from { background-position: 0 0; }
  to { background-position: -384px 0; }
}
```

For `success` or `error`, play the animation once and then return to `idle`.
For accessibility, pause or simplify the loop when `prefers-reduced-motion: reduce` is enabled.
