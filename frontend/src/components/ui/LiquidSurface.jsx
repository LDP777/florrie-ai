import { Liquid } from 'liquid-gooey';

export default function LiquidSurface({ width, index, count }) {
  const step = width / count;
  return <Liquid className="fl-liquid-surface" fill="var(--selection-fill, var(--accent-light))" blur={4} contrast={20}>
    <Liquid.Item x={index * step} y={0} transition="snappy" radius={14} style={{ position: 'absolute', left: 0, top: 0, width: step, height: '100%' }}>
      <span style={{ display: 'block', width: step, height: '100%', borderRadius: 14, background: 'transparent' }} />
    </Liquid.Item>
  </Liquid>;
}
