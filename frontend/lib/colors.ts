export type RGB = [number, number, number]
type Stop = [number, RGB]

/** Linear interpolation across a colour ramp. */
export function colorRamp(stops: Stop[], t: number): RGB {
  const lo = stops[0][0], hi = stops[stops.length - 1][0]
  const clamped = Math.max(lo, Math.min(hi, t))
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (clamped >= t0 && clamped <= t1) {
      const f = (clamped - t0) / (t1 - t0)
      return c0.map((v, j) => Math.round(v + f * (c1[j] - v))) as RGB
    }
  }
  return stops[stops.length - 1][1]
}

// screen blend mode: darks are transparent, brights glow through the map
export const tempColor    = (t: number): RGB => colorRamp([
  [10, [5,0,50]],   [18,[10,20,150]],  [24,[0,100,220]],
  [28,[0,200,80]],  [32,[220,200,0]],  [36,[255,80,0]],  [40,[255,255,80]],
], t)

export const heatColor    = (h: number): RGB => colorRamp([
  [18,[5,0,60]],    [24,[0,80,200]],   [29,[0,185,70]],
  [33,[255,140,0]], [38,[255,15,0]],   [42,[200,0,200]],
], h)

// multiply blend mode: whites are transparent, colours darken the map
export const waveColor    = (h: number): RGB => colorRamp([
  [0,[255,255,255]], [0.3,[200,240,255]], [1,[100,190,255]],
  [2.5,[30,120,255]], [4.5,[0,50,200]], [7,[60,0,160]],
], h)

export const windColor    = (spd: number): RGB => colorRamp([
  [0,[3,80,200]], [8,[0,200,255]], [15,[0,230,70]],
  [25,[255,230,0]], [35,[255,120,0]], [45,[255,30,30]],
], spd)

// screen blend: black=transparent, bright colours glow through dark map (Windy-style)
export const precipColor  = (p: number): RGB => colorRamp([
  [0,   [0,  0,  0  ]],   // fully transparent
  [0.4, [0,  80, 30 ]],   // barely visible
  [1,   [0,  190, 60]],   // green
  [4,   [80, 215, 0 ]],   // yellow-green
  [10,  [230,210, 0 ]],   // yellow
  [25,  [255,110, 0 ]],   // orange
  [50,  [255, 10, 0 ]],   // red
  [80,  [180,  0,220]],   // purple
], p)

// screen blend: black=transparent, yellow/orange/purple for storm index
export const thunderColor = (v: number): RGB => colorRamp([
  [0,   [0,  0,  0  ]],   // fully transparent
  [18,  [30, 25, 0  ]],   // barely visible
  [35,  [120,90, 0  ]],   // dark yellow
  [55,  [220,160,0  ]],   // yellow
  [72,  [255, 70, 0 ]],   // orange
  [88,  [200,  0,160]],   // purple
  [100, [255,  0,255]],   // magenta
], v)

export const seasonColor  = (d: number): RGB => colorRamp([
  [0,[20,30,80]], [0.25,[60,0,160]], [0.5,[150,0,150]],
  [0.75,[200,0,100]], [1,[255,30,60]],
], d)

export const rgb = ([r,g,b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`

/**
 * Smooth Windy-style overlay:
 * Draws solid circles on an offscreen canvas then composites
 * with Gaussian blur for a continuous colour field.
 */
export function drawSmoothField(
  canvas: HTMLCanvasElement,
  points: Array<{ x: number; y: number; value: number | null }>,
  colorFn: (v: number) => RGB,
  options: { blurPx?: number; radius?: number } = {},
): void {
  const { blurPx = 16, radius = 90 } = options
  const W = canvas.width, H = canvas.height
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H)

  const tmp = document.createElement('canvas')
  tmp.width = W; tmp.height = H
  const tctx = tmp.getContext('2d')!

  points.forEach(({ x, y, value }) => {
    if (value === null || value === undefined) return
    const [r, g, b] = colorFn(value)
    tctx.fillStyle = `rgb(${r},${g},${b})`
    tctx.beginPath()
    tctx.arc(x, y, radius, 0, Math.PI * 2)
    tctx.fill()
  })

  ctx.save()
  ctx.globalAlpha = 1   // opacity is controlled by the canvas element's CSS
  if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`
  ctx.drawImage(tmp, 0, 0)
  ctx.restore()
}
