# WebGPU Viewer — Post-Processing

The Post FX panel applies screen-space effects after the volume itself is rendered — these affect the
final image, not the volume data or the transfer function.

- **Tonemap** — the tone-mapping operator: `aces`, `reinhard`, or `reinhard-extended`. Always applied.
- **Exposure (stops)** — post-processing exposure adjustment, in photographic stops (separate from the
  Render panel's volume [Exposure](webgpu-rendering-lighting.md)).
- **Bloom** — toggle, plus **Bloom threshold** and **Bloom intensity**. Adds a soft glow around bright
  areas.
- **FXAA (anti-alias edges)** — fast approximate anti-aliasing to smooth jagged edges.
- **Sharpen** — toggle, plus **Sharpen amount**. Edge-sharpening filter.
- **Vignette** — toggle, plus **Vignette amount**. Darkens the corners of the frame.

!!! tip
    These are cheap, always-on-canvas effects — safe to leave enabled while adjusting the transfer
    function or lighting, unlike the [Lighting panel's](webgpu-rendering-lighting.md) shadow/AO
    controls which cost real GPU time per sample.
