import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { simulate } from '../sim/engine';
import { importSimulink } from './simulink';
import { parseXml } from './xml';

const last = (y: number[]) => y[y.length - 1];

/** Minimal ZIP writer (deflate), enough to build .slx packages for the tests. */
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), raw = enc.encode(text), data = deflateRawSync(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, nameB.length, true);
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...nameB, ...data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...nameB]));
    locals.push(local);
    offset += local.length;
  }
  const cd = centrals.reduce((n, c) => n + c.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, centrals.length, true); eo.setUint16(10, centrals.length, true);
  eo.setUint32(12, cd, true); eo.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eo.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const SLX = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="utf-8"?><Types/>',
  'simulink/blockdiagram.xml': `<?xml version="1.0" encoding="utf-8"?>
<ModelInformation Version="1.0">
  <Model Name="pid_loop">
    <P Name="InitFcn">Kp = 2;
Ki = 1;</P>
    <System Ref="system_root"/>
  </Model>
</ModelInformation>`,
  'simulink/bddefaults.xml': `<?xml version="1.0" encoding="utf-8"?>
<BlockDiagramDefaults>
  <BlockParameterDefaults>
    <Block BlockType="TransferFcn"><P Name="Numerator">[1]</P><P Name="Denominator">[1 2 1]</P></Block>
    <Block BlockType="Step"><P Name="Time">1</P><P Name="Before">0</P><P Name="After">1</P></Block>
  </BlockParameterDefaults>
</BlockDiagramDefaults>`,
  'simulink/configSet0.xml': `<?xml version="1.0" encoding="utf-8"?>
<ConfigSet><Object ClassName="Simulink.ConfigSet"><Array><Object ClassName="Simulink.SolverCC">
  <P Name="StartTime">0.0</P><P Name="StopTime">30</P><P Name="Solver">ode15s</P><P Name="RelTol">1e-4</P>
</Object></Array></Object></ConfigSet>`,
  'simulink/systems/system_root.xml': `<?xml version="1.0" encoding="utf-8"?>
<System>
  <Block BlockType="Step" Name="Ref" SID="1"><P Name="Position">[20, 50, 50, 80]</P><P Name="Time">0</P></Block>
  <Block BlockType="Sum" Name="Sum" SID="2"><P Name="Position">[90, 55, 110, 75]</P><P Name="Inputs">|+-</P></Block>
  <Block BlockType="SubSystem" Name="PID" SID="3">
    <P Name="Position">[140, 45, 200, 85]</P>
    <P Name="ReferenceBlock">simulink/Continuous/PID Controller</P>
    <Mask><MaskParameter Name="P" Type="edit"><Prompt>P</Prompt><Value>Kp</Value></MaskParameter>
      <MaskParameter Name="I" Type="edit"><Prompt>I</Prompt><Value>Ki</Value></MaskParameter>
      <MaskParameter Name="D" Type="edit"><Prompt>D</Prompt><Value>0</Value></MaskParameter></Mask>
    <System Ref="system_3"/>
  </Block>
  <Block BlockType="TransferFcn" Name="Plant" SID="4"><P Name="Position">[240, 45, 300, 85]</P></Block>
  <Block BlockType="Mux" Name="Mux" SID="5"><P Name="Ports">[2, 1]</P><P Name="Position">[340, 40, 345, 90]</P><P Name="Inputs">2</P></Block>
  <Block BlockType="Scope" Name="Scope" SID="6"><P Name="Position">[380, 50, 410, 80]</P></Block>
  <Block BlockType="Gain" Name="Fb" SID="7"><P Name="Position">[240, 120, 270, 150]</P><P Name="BlockMirror">on</P></Block>
  <Line><P Name="Src">1#out:1</P><P Name="Dst">2#in:1</P></Line>
  <Line><P Name="Src">2#out:1</P><P Name="Dst">3#in:1</P></Line>
  <Line><P Name="Src">3#out:1</P><P Name="Dst">4#in:1</P></Line>
  <Line><P Name="Src">4#out:1</P>
    <Branch><P Name="Dst">5#in:1</P></Branch>
    <Branch><P Name="Dst">7#in:1</P></Branch>
  </Line>
  <Line><P Name="Src">7#out:1</P><P Name="Dst">2#in:2</P></Line>
  <Line><P Name="Src">1#out:1</P><P Name="Dst">5#in:2</P></Line>
  <Line><P Name="Src">5#out:1</P><P Name="Dst">6#in:1</P></Line>
</System>`,
  'simulink/systems/system_3.xml': '<?xml version="1.0" encoding="utf-8"?><System><Block BlockType="Inport" Name="u" SID="3::1"/></System>',
};

describe('XML reader', () => {
  it('parses elements, attributes, entities and CDATA', () => {
    const doc = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b>t&lt;3</b><c/><![CDATA[<raw>]]></a>');
    const a = doc.children[0];
    expect(a.attrs.x).toBe('1 & 2');
    expect(a.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(a.children[0].text).toBe('t<3');
    expect(a.text).toBe('<raw>');
  });
});

describe('Simulink import', () => {
  it('opens a classic .mdl model and simulates it', async () => {
    const bytes = readFileSync(new URL('./fixtures/spring.mdl', import.meta.url));
    const { model, warnings } = await importSimulink('spring.mdl', new Uint8Array(bytes));
    expect(model.name).toBe('spring');
    expect(model.settings.stopTime).toBe('pi');
    expect(model.settings.relTol).toBe('1e-6');
    expect(model.workspace).toContain('k = 4');
    const gain = model.blocks.find((b) => b.name === '-k/m')!;
    expect(gain.params.K).toBe('-k/m');
    expect(gain.flip).toBe(true);
    const sub = model.blocks.find((b) => b.type === 'Subsystem')!;
    expect(sub.mask?.params[0]).toMatchObject({ name: 'g', label: 'Gain', default: '3' });
    expect(model.blocks.find((b) => b.name === 'Legacy')!.type).toBe('Unsupported');
    expect(warnings.some((w) => w.includes('M-S-Function'))).toBe(true);
    expect(model.links).toHaveLength(7); // branches expanded

    const r = simulate(model);
    const scope = model.blocks.find((b) => b.type === 'Scope')!;
    const display = model.blocks.find((b) => b.type === 'Display')!;
    expect(last(r.logs[scope.id].y[0])).toBeCloseTo(Math.cos(2 * Math.PI), 4);
    expect(last(r.logs[display.id].y[0])).toBeCloseTo(3, 3);
  });

  it('opens an .slx package with split systems, defaults and a PID controller', async () => {
    const { model, warnings } = await importSimulink('pid_loop.slx', zip(SLX));
    expect(model.settings).toMatchObject({ stopTime: '30', solver: 'ode23s', relTol: '1e-4' });
    expect(warnings.some((w) => w.includes('ode15s'))).toBe(true);
    const types = Object.fromEntries(model.blocks.map((b) => [b.name, b.type]));
    expect(types).toMatchObject({ Ref: 'Step', Sum: 'Sum', PID: 'PID', Plant: 'TransferFcn', Mux: 'Mux', Scope: 'Scope' });
    expect(model.blocks.find((b) => b.name === 'Sum')!.params.signs).toBe('+-');
    expect(model.blocks.find((b) => b.name === 'Plant')!.params.den).toBe('[1 2 1]');
    expect(model.blocks.find((b) => b.name === 'PID')!.params).toMatchObject({ P: 'Kp', I: 'Ki', D: '0' });

    const r = simulate(model);
    const scope = model.blocks.find((b) => b.type === 'Scope')!;
    const log = r.logs[scope.id];
    expect(log.y).toHaveLength(2); // plant output and reference through the Mux
    expect(last(log.y[0])).toBeCloseTo(1, 2); // PI control removes the steady-state error
    expect(last(log.y[1])).toBe(1);
  });

  it('rejects files that are not models', async () => {
    await expect(importSimulink('x.mdl', new TextEncoder().encode('hello'))).rejects.toThrow(/Model/);
    await expect(importSimulink('x.slx', zip({ 'a.txt': 'x' }))).rejects.toThrow(/blockdiagram/);
  });
});
