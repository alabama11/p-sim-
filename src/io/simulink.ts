// Import of Simulink models: .slx (ZIP package with XML parts) and .mdl (text format,
// classic and the newer text-packaged variant). Both are read into one neutral form
// (RawSystem) and then converted to a P-Sim Model. Blocks without a P-Sim counterpart
// become "Unsupported" placeholders so that the diagram still opens; each such case
// is reported in the returned warnings.

import { compileScript } from '../sim/expr';
import { defaultSettings, emptyModel, type BlockModel, type Diagram, type MaskDef, type Model, type SolverName } from '../sim/types';
import { blockSize } from '../ui/geometry';
import { findAll, kid, kids, parseXml, type XmlNode } from './xml';
import { unzip, type ZipFiles } from './zip';

// ---------------- Neutral form ----------------

interface RawMask {
  title: string;
  description: string;
  params: { name: string; prompt: string; value: string }[];
}

interface RawBlock {
  type: string;
  name: string;
  sid: string;
  params: Record<string, string>;
  system?: RawSystem;
  mask?: RawMask;
  ports?: [number, number];
}

interface RawEnd {
  key: string; // block name (.mdl) or SID (.slx)
  port: number; // 1-based
  kind: string; // in, out, or a special port (enable, trigger, ...)
}

interface RawSystem {
  blocks: RawBlock[];
  lines: { src: RawEnd; dst: RawEnd[] }[];
}

interface RawModel {
  name: string;
  root: RawSystem;
  config: Record<string, string>;
  defaults: Record<string, Record<string, string>>;
  callbacks: string[];
}

export interface ImportResult {
  model: Model;
  warnings: string[];
}

const CONFIG_KEYS = ['StartTime', 'StopTime', 'Solver', 'SolverType', 'FixedStep', 'MaxStep', 'RelTol', 'AbsTol'];
const CALLBACK_KEYS = ['PreLoadFcn', 'PostLoadFcn', 'InitFcn'];

/** Imports a .slx or .mdl file given its name and bytes. */
export async function importSimulink(fileName: string, bytes: Uint8Array): Promise<ImportResult> {
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.(slx|mdl)$/i, '') || 'model';
  let raw: RawModel;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    raw = readPackage(await unzip(bytes), name);
  } else {
    const text = new TextDecoder().decode(bytes);
    raw = text.includes('__MWOPC_PART_BEGIN__') ? readPackage(opcTextParts(text), name) : readMdl(text, name);
  }
  return convert(raw);
}

// ---------------- .slx and packaged .mdl (XML parts) ----------------

/** Newer .mdl files hold the same XML parts as .slx, as text sections. */
function opcTextParts(text: string): ZipFiles {
  const files: ZipFiles = new Map();
  const enc = new TextEncoder();
  const parts = text.split(/^__MWOPC_PART_BEGIN__\s*/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const path = part.slice(0, nl).trim().replace(/^\//, '');
    files.set(path, enc.encode(part.slice(nl + 1).replace(/__MWOPC_PACKAGE_END__[\s\S]*$/, '')));
  }
  return files;
}

function readPackage(files: ZipFiles, name: string): RawModel {
  const dec = new TextDecoder();
  const xml = (path: string) => {
    const f = files.get(path);
    return f ? parseXml(dec.decode(f)) : undefined;
  };
  const doc = xml('simulink/blockdiagram.xml');
  if (!doc) throw new Error('V súbore chýba simulink/blockdiagram.xml, nejde o model Simulinku');
  const model = findAll(doc, 'Model')[0] ?? findAll(doc, 'Library')[0];
  if (!model) throw new Error('Súbor neobsahuje model');

  const loadSystem = (node: XmlNode): XmlNode => {
    const ref = node.attrs.Ref;
    if (!ref) return node;
    const part = xml(`simulink/systems/${ref}.xml`);
    const sys = part && findAll(part, 'System')[0];
    if (!sys) throw new Error(`V súbore chýba časť simulink/systems/${ref}.xml`);
    return sys;
  };

  const props = (n: XmlNode) => {
    const out: Record<string, string> = {};
    for (const p of kids(n, 'P')) if (p.attrs.Name && !(p.attrs.Name in out)) out[p.attrs.Name] = p.text.trim();
    return out;
  };

  const readMask = (b: XmlNode, params: Record<string, string>): RawMask | undefined => {
    const m = kid(b, 'Mask');
    if (m) {
      return {
        title: kid(m, 'Display')?.text.trim().replace(/^disp\(['"](.*)['"]\)$/, '$1') ?? '',
        description: kid(m, 'Description')?.text.trim() ?? '',
        params: kids(m, 'MaskParameter').map((mp) => ({
          name: mp.attrs.Name ?? '',
          prompt: kid(mp, 'Prompt')?.text.trim() ?? mp.attrs.Name ?? '',
          value: kid(mp, 'Value')?.text.trim() ?? '',
        })),
      };
    }
    return legacyMask(params);
  };

  const parseEnd = (s: string): RawEnd | null => {
    const m = /^([^#]+)#(\w+)(?::(\d+))?$/.exec(s.trim());
    return m ? { key: m[1], kind: m[2], port: m[3] ? parseInt(m[3], 10) : 1 } : null;
  };

  const readSystem = (sysNode: XmlNode): RawSystem => {
    const sys = loadSystem(sysNode);
    const blocks: RawBlock[] = kids(sys, 'Block').map((b) => {
      const params = props(b);
      const inst = kid(b, 'InstanceData');
      if (inst) Object.assign(params, props(inst));
      const pc = kid(b, 'PortCounts');
      const sub = kid(b, 'System');
      return {
        type: b.attrs.BlockType ?? 'Unknown',
        name: b.attrs.Name ?? '',
        sid: b.attrs.SID ?? '',
        params,
        system: sub ? readSystem(sub) : undefined,
        mask: readMask(b, params),
        ports: pc ? [parseInt(pc.attrs.in ?? '0', 10), parseInt(pc.attrs.out ?? '0', 10)] : portsParam(params.Ports),
      };
    });
    const lines: RawSystem['lines'] = [];
    for (const l of kids(sys, 'Line')) {
      const src = parseEnd(props(l).Src ?? '');
      const dst: RawEnd[] = [];
      const walk = (n: XmlNode) => {
        const d = parseEnd(props(n).Dst ?? '');
        if (d) dst.push(d);
        kids(n, 'Branch').forEach(walk);
      };
      walk(l);
      if (src) lines.push({ src, dst });
    }
    return { blocks, lines };
  };

  const sys = kid(model, 'System');
  if (!sys) throw new Error('Model neobsahuje diagram (System)');

  const defaults: RawModel['defaults'] = {};
  for (const d of [doc, xml('simulink/bddefaults.xml')]) {
    if (!d) continue;
    for (const bpd of findAll(d, 'BlockParameterDefaults')) {
      for (const b of kids(bpd, 'Block')) defaults[b.attrs.BlockType] = { ...props(b), ...defaults[b.attrs.BlockType] };
    }
  }

  const config: Record<string, string> = {};
  const configDocs = [...files.keys()].filter((k) => /^simulink\/configSet\d*\.xml$/.test(k)).sort().map(xml);
  for (const d of [...configDocs, doc]) {
    if (!d) continue;
    for (const p of findAll(d, 'P')) {
      const k = p.attrs.Name;
      if (k && CONFIG_KEYS.includes(k) && !(k in config) && p.children.length === 0) config[k] = p.text.trim();
    }
  }
  const mp = props(model);
  return {
    name: mp.Name || name,
    root: readSystem(sys),
    config,
    defaults,
    callbacks: CALLBACK_KEYS.map((k) => mp[k]).filter(Boolean),
  };
}

function portsParam(s?: string): [number, number] | undefined {
  if (!s) return undefined;
  const n = s.replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean).map((x) => parseInt(x, 10));
  return [n[0] || 0, n[1] || 0];
}

/** Masks stored as MaskVariables "a=@1;b=@2;" with MaskValueString "1|2" (older files). */
function legacyMask(params: Record<string, string>): RawMask | undefined {
  if (!params.MaskVariables && !params.MaskType && !params.MaskDisplay) return undefined;
  const vars = (params.MaskVariables ?? '').split(';').map((v) => v.split('=')[0].trim()).filter(Boolean);
  const values = (params.MaskValueString ?? '').split('|');
  const prompts = (params.MaskPromptString ?? '').split('|');
  return {
    title: (params.MaskDisplay ?? '').replace(/^disp\(['"](.*)['"]\)$/, '$1') || params.MaskType || '',
    description: params.MaskDescription ?? '',
    params: vars.map((v, i) => ({ name: v, prompt: prompts[i] ?? v, value: values[i] ?? '' })),
  };
}

// ---------------- classic .mdl text ----------------

interface MdlSection {
  name: string;
  props: Record<string, string>;
  sections: MdlSection[];
}

function parseMdlText(text: string): MdlSection {
  const root: MdlSection = { name: '#root', props: {}, sections: [] };
  const stack = [root];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const top = stack[stack.length - 1];
    if (line === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const sec = /^(\S+)\s*\{$/.exec(line);
    if (sec) {
      const s: MdlSection = { name: sec[1], props: {}, sections: [] };
      top.sections.push(s);
      stack.push(s);
      continue;
    }
    const kv = /^(\S+)\s+(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      value = unquote(value);
      // Long strings continue on the next lines as further quoted pieces.
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('"')) value += unquote(lines[++i].trim());
    }
    if (!(kv[1] in top.props)) top.props[kv[1]] = value;
  }
  return root;
}

/** Concatenates the quoted pieces of one line: "abc" "def" → abcdef. */
function unquote(s: string): string {
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += m[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return out;
}

function readMdl(text: string, name: string): RawModel {
  const root = parseMdlText(text);
  const model = root.sections.find((s) => s.name === 'Model' || s.name === 'Library');
  if (!model) throw new Error('Súbor nie je model Simulinku (chýba sekcia Model)');

  const readSystem = (sys: MdlSection): RawSystem => {
    const blocks: RawBlock[] = sys.sections.filter((s) => s.name === 'Block').map((b) => {
      const params = { ...b.props };
      const sub = b.sections.find((s) => s.name === 'System');
      return {
        type: b.props.BlockType ?? 'Unknown',
        name: b.props.Name ?? '',
        sid: b.props.SID ?? '',
        params,
        system: sub ? readSystem(sub) : undefined,
        mask: mdlMask(b) ?? legacyMask(params),
        ports: portsParam(params.Ports),
      };
    });
    const lines: RawSystem['lines'] = [];
    for (const l of sys.sections.filter((s) => s.name === 'Line')) {
      if (!l.props.SrcBlock) continue;
      const dst: RawEnd[] = [];
      const walk = (n: MdlSection) => {
        if (n.props.DstBlock) dst.push(mdlEnd(n.props.DstBlock, n.props.DstPort, 'in'));
        n.sections.filter((s) => s.name === 'Branch').forEach(walk);
      };
      walk(l);
      lines.push({ src: mdlEnd(l.props.SrcBlock, l.props.SrcPort, 'out'), dst });
    }
    return { blocks, lines };
  };

  const sys = model.sections.find((s) => s.name === 'System');
  if (!sys) throw new Error('Model neobsahuje diagram (System)');

  const defaults: RawModel['defaults'] = {};
  for (const bpd of model.sections.filter((s) => s.name === 'BlockParameterDefaults')) {
    for (const b of bpd.sections.filter((s) => s.name === 'Block')) defaults[b.props.BlockType] = b.props;
  }
  const config: Record<string, string> = {};
  const scan = (s: MdlSection) => {
    for (const k of CONFIG_KEYS) if (k in s.props && !(k in config)) config[k] = s.props[k];
    for (const c of s.sections) if (c.name !== 'System' && c.name !== 'BlockParameterDefaults') scan(c);
  };
  scan(model);
  return {
    name: model.props.Name || name,
    root: readSystem(sys),
    config,
    defaults,
    callbacks: CALLBACK_KEYS.map((k) => model.props[k]).filter(Boolean),
  };
}

function mdlEnd(block: string, port: string | undefined, dflt: string): RawEnd {
  const n = parseInt(port ?? '1', 10);
  return { key: block, port: isNaN(n) ? 1 : n, kind: isNaN(n) && port ? port : dflt };
}

/** Masks of R2012+ .mdl files: a MaskObject section with Simulink.MaskParameter objects. */
function mdlMask(b: MdlSection): RawMask | undefined {
  const mo = b.sections.find((s) => s.name === 'MaskObject');
  if (!mo) return undefined;
  const params: RawMask['params'] = [];
  const walk = (s: MdlSection) => {
    if (s.name === 'Object' && s.props.Name && 'Value' in s.props) {
      params.push({ name: s.props.Name, prompt: s.props.Prompt ?? s.props.Name, value: s.props.Value });
    }
    s.sections.forEach(walk);
  };
  walk(mo);
  return {
    title: (mo.props.Display ?? '').replace(/^disp\(['"](.*)['"]\)$/, '$1'),
    description: mo.props.Description ?? '',
    params,
  };
}

// ---------------- Conversion to a P-Sim model ----------------

const TRIG = ['sin', 'cos', 'tan'];
const MATH: Record<string, string> = { exp: 'exp', log: 'log', square: 'square', sqrt: 'sqrt' };

/** MATLAB expression → P-Sim expression (transposes are no-ops on our row vectors). */
function expr(s: string): string {
  return s.trim().replace(/(\]|\w|\))'/g, '$1');
}

function convert(raw: RawModel): ImportResult {
  const warnings: string[] = [];
  const unsupported = new Map<string, number>();
  let nextId = 0;
  const model = emptyModel(raw.name);

  const convSystem = (sys: RawSystem, path: string): Diagram => {
    const blocks: BlockModel[] = [];
    const byKey = new Map<string, BlockModel>();
    for (const rb of sys.blocks) {
      const b = convBlock(rb, path);
      if (!b) continue;
      blocks.push(b);
      byKey.set(rb.name, b);
      if (rb.sid) byKey.set(rb.sid, b);
    }
    const links: Diagram['links'] = [];
    for (const l of sys.lines) {
      const sb = byKey.get(l.src.key);
      if (!sb || l.src.kind !== 'out') continue;
      for (const d of l.dst) {
        const db = byKey.get(d.key);
        if (!db) continue;
        if (d.kind !== 'in') {
          warnings.push(`${path}${db.name}: port „${d.kind}“ (napr. enable/trigger) nie je podporovaný, spojenie sa vynechalo.`);
          continue;
        }
        links.push({ id: `l${++nextId}`, src: { block: sb.id, port: l.src.port - 1 }, dst: { block: db.id, port: d.port - 1 } });
      }
    }
    return { blocks, links };
  };

  const convBlock = (rb: RawBlock, path: string): BlockModel | null => {
    const dflt = raw.defaults[rb.type] ?? {};
    const g = (key: string, fallback: string) => rb.params[key] ?? dflt[key] ?? fallback;
    const pos = (g('Position', '[0, 0, 40, 40]').match(/-?\d+(\.\d+)?/g) ?? ['0', '0', '40', '40']).map(Number);
    // Remember the centre for now; P-Sim blocks are larger, so the layout is spread out later.
    const b: BlockModel = {
      id: `b${++nextId}`,
      type: '',
      name: rb.name.replace(/\n/g, ' ') || rb.type,
      x: (pos[0] + (pos[2] ?? pos[0])) / 2,
      y: (pos[1] + (pos[3] ?? pos[1])) / 2,
      params: {},
    };
    if (g('BlockMirror', 'off') === 'on' || g('Orientation', 'right') === 'left') b.flip = true;
    const here = `${path}${b.name}`;
    const note = (msg: string) => warnings.push(`${here}: ${msg}`);
    const set = (type: string, params: Record<string, string>) => {
      b.type = type;
      for (const [k, v] of Object.entries(params)) b.params[k] = expr(v);
      return b;
    };
    const sampleTime = (key: string, fallback: string) => {
      const ts = g(key, fallback).trim();
      if (ts === '-1' || ts === 'inf' || ts === '') {
        const fs = raw.config.FixedStep;
        const v = fs && fs !== 'auto' ? fs : '1';
        note(`zdedená perióda vzorkovania (${ts || 'prázdna'}) sa nahradila hodnotou ${v}.`);
        return v;
      }
      return ts.replace(/^\[\s*([^,\s\]]+).*\]$/, '$1'); // [Ts offset] → Ts
    };
    const ref = rb.type === 'Reference' ? (g('SourceBlock', '').split('/').pop() ?? '').replace(/\n/g, ' ') : '';
    const refBlock = (g('ReferenceBlock', '').split('/').pop() ?? '').replace(/\n/g, ' ');

    switch (ref || (rb.type === 'SubSystem' && /PID Controller/.test(refBlock) ? 'PID Controller' : rb.type)) {
      case 'Constant': return set('Constant', { value: g('Value', '1') });
      case 'Ground': return set('Constant', { value: '0' });
      case 'Step': return set('Step', { time: g('Time', '1'), before: g('Before', '0'), after: g('After', '1') });
      case 'Ramp': return set('Ramp', { slope: g('slope', '1'), start: g('start', '0'), initial: g('InitialOutput', g('X0', '0')) });
      case 'Sin':
        if (g('SineType', 'Time based') !== 'Time based') note('sínus podľa vzoriek sa importoval ako časový.');
        return set('SineWave', { amplitude: g('Amplitude', '1'), frequency: g('Frequency', '1'), phase: g('Phase', '0'), bias: g('Bias', '0') });
      case 'DiscretePulseGenerator':
        return set('PulseGenerator', { amplitude: g('Amplitude', '1'), period: g('Period', '10'), width: g('PulseWidth', '5'), delay: g('PhaseDelay', '0') });
      case 'Clock': return set('Clock', {});
      case 'RandomNumber':
        return set('RandomNumber', { mean: g('Mean', '0'), variance: g('Variance', '1'), seed: g('Seed', '0'), Ts: sampleTime('SampleTime', '0.1') });
      case 'Gain':
        if (!/Element-wise/.test(g('Multiplication', 'Element-wise(K.*u)'))) note('maticové násobenie nie je podporované, použije sa násobenie po prvkoch.');
        return set('Gain', { K: g('Gain', '1') });
      case 'Sum': {
        let s = g('Inputs', '|++').replace(/[|\s]/g, '');
        if (/^\d+$/.test(s)) s = '+'.repeat(Math.max(1, parseInt(s, 10)));
        b.type = 'Sum';
        b.params.signs = s.replace(/[^+-]/g, '') || '+';
        return b;
      }
      case 'Product': {
        let s = g('Inputs', '2').trim();
        if (/^\d+$/.test(s)) s = '*'.repeat(Math.max(1, parseInt(s, 10)));
        if (g('Multiplication', 'Element-wise(.*)') !== 'Element-wise(.*)') note('maticový súčin nie je podporovaný, použije sa súčin po prvkoch.');
        b.type = 'Product';
        b.params.ops = s.replace(/[^*/]/g, '') || '*';
        return b;
      }
      case 'Abs': return set('MathFunction', { fn: 'abs' });
      case 'Signum': return set('MathFunction', { fn: 'sign' });
      case 'Sqrt': return set('MathFunction', { fn: 'sqrt' });
      case 'Trigonometry': {
        const op = g('Operator', 'sin');
        if (TRIG.includes(op)) return set('MathFunction', { fn: op });
        return set('Fcn', { expr: `${op}(u)` });
      }
      case 'Math': {
        const op = g('Operator', 'exp');
        if (MATH[op]) return set('MathFunction', { fn: MATH[op] });
        const expr2: Record<string, string> = { log10: 'log10(u)', '10^u': '10.^u', reciprocal: '1./u', magnitude2: 'u.^2', pow: 'u(1).^u(2)' };
        if (expr2[op]) return set('Fcn', { expr: expr2[op] });
        break;
      }
      case 'MinMax': return set('MinMax', { fn: g('Function', 'min'), inputs: g('Inputs', '1') });
      case 'RelationalOperator': {
        const op = g('Operator', '>=');
        if (!['==', '~=', '<', '<=', '>', '>='].includes(op)) break;
        b.type = 'RelationalOperator';
        b.params.op = op;
        return b;
      }
      case 'Logic': {
        b.type = 'LogicalOperator';
        b.params.op = g('Operator', 'AND');
        b.params.inputs = g('Inputs', '2');
        return b;
      }
      case 'Integrator':
        if (g('ExternalReset', 'none') !== 'none' || g('LimitOutput', 'off') === 'on' || g('InitialConditionSource', 'internal') !== 'internal') {
          note('reset, obmedzenie výstupu a externá počiatočná podmienka integrátora nie sú podporované.');
        }
        return set('Integrator', { x0: g('InitialCondition', '0') });
      case 'TransferFcn': return set('TransferFcn', { num: g('Numerator', '[1]'), den: g('Denominator', '[1 1]') });
      case 'PID Controller': {
        if (g('Controller', 'PID') !== 'PID') note(`typ regulátora ${g('Controller', 'PID')} sa importoval ako PID.`);
        if (g('TimeDomain', 'Continuous-time') !== 'Continuous-time') note('diskrétny PID sa importoval ako spojitý.');
        const mv = (k: string, d: string) => rb.mask?.params.find((p) => p.name === k)?.value ?? g(k, d);
        return set('PID', { P: mv('P', '1'), I: mv('I', '1'), D: mv('D', '0'), N: mv('N', '100') });
      }
      case 'Derivative': return set('Derivative', {});
      case 'TransportDelay': return set('TransportDelay', { delay: g('DelayTime', '1'), initial: g('InitialOutput', '0') });
      case 'UnitDelay':
        return set('UnitDelay', { x0: g('InitialCondition', g('X0', '0')), Ts: sampleTime('SampleTime', '-1') });
      case 'ZeroOrderHold': return set('ZeroOrderHold', { Ts: sampleTime('SampleTime', '-1') });
      case 'DiscreteIntegrator':
        if (g('IntegratorMethod', 'Integration: Forward Euler') !== 'Integration: Forward Euler') note('metóda integrácie sa nahradila doprednou Eulerovou.');
        return set('DiscreteIntegrator', { K: g('gainval', '1.0'), x0: g('InitialCondition', '0'), Ts: sampleTime('SampleTime', '1') });
      case 'DiscreteTransferFcn':
        return set('DiscreteTransferFcn', { num: g('Numerator', '[1]'), den: g('Denominator', '[1 0.5]'), Ts: sampleTime('SampleTime', '1') });
      case 'Saturate': return set('Saturation', { upper: g('UpperLimit', '0.5'), lower: g('LowerLimit', '-0.5') });
      case 'DeadZone': return set('DeadZone', { start: g('LowerValue', '-0.5'), end: g('UpperValue', '0.5') });
      case 'Relay':
        return set('Relay', { on: g('OnSwitchValue', 'eps'), off: g('OffSwitchValue', 'eps'), yon: g('OnOutputValue', '1'), yoff: g('OffOutputValue', '0') });
      case 'Switch': {
        const c = g('Criteria', 'u2 >= Threshold');
        b.type = 'Switch';
        b.params.criterion = c.startsWith('u2 > ') ? 'u2 > prah' : c.startsWith('u2 ~=') ? 'u2 ~= 0' : 'u2 >= prah';
        b.params.threshold = expr(g('Threshold', '0'));
        return b;
      }
      case 'Mux': return set('Mux', { inputs: countSpec(g('Inputs', '4')) });
      case 'Demux': return set('Demux', { outputs: countSpec(g('Outputs', '2')) });
      case 'Fcn': {
        b.type = 'Fcn';
        b.params.expr = g('Expr', g('Expression', 'u'));
        return b;
      }
      case 'Scope': return set('Scope', { inputs: g('NumInputPorts', '1') });
      case 'Display': return set('Display', {});
      case 'Inport': return set('Inport', { port: g('Port', '1') });
      case 'Outport': return set('Outport', { port: g('Port', '1') });
      case 'Terminator': return set('Terminator', {});
      case 'ToWorkspace':
        note('blok To Workspace sa nahradil blokom Terminator; signál si pozrite v Scope.');
        return set('Terminator', {});
      case 'SubSystem': {
        const sf = g('SFBlockType', 'NONE');
        if (sf !== 'NONE' || !rb.system) break; // MATLAB Function, Stateflow chart...
        if (g('TreatAsAtomicUnit', 'off') === 'on') { /* atomic subsystems simulate the same here */ }
        const special = rb.system.blocks.find((x) => ['EnablePort', 'TriggerPort', 'ActionPort', 'ForIterator', 'WhileIterator'].includes(x.type));
        if (special) note(`podmienený subsystém (${special.type}) sa simuluje ako obyčajný.`);
        b.type = 'Subsystem';
        b.children = convSystem(rb.system, `${here}/`);
        if (rb.mask?.params.length || rb.mask?.title) {
          const mask: MaskDef = {
            title: rb.mask.title,
            description: rb.mask.description,
            params: rb.mask.params.filter((p) => /^[A-Za-z_]\w*$/.test(p.name)).map((p) => ({ name: p.name, label: p.prompt, default: expr(p.value || '0') })),
          };
          b.mask = mask;
          for (const p of mask.params) b.params[p.name] = p.default;
        }
        return b;
      }
      case 'EnablePort': case 'TriggerPort': case 'ActionPort':
        return null; // reported with the subsystem
    }

    // No counterpart: keep a placeholder with the same ports.
    const kind = ref || (rb.type === 'SubSystem' && g('SFBlockType', 'NONE') !== 'NONE' ? g('SFBlockType', '') : rb.type);
    unsupported.set(kind, (unsupported.get(kind) ?? 0) + 1);
    const [nin, nout] = rb.ports ?? [rb.type === 'Outport' ? 1 : 1, 1];
    b.type = 'Unsupported';
    b.params = { kind, inputs: String(nin), outputs: String(nout) };
    return b;
  };

  const root = convSystem(raw.root, '');
  model.blocks = root.blocks;
  model.links = root.links;
  normalizePositions(model);

  // Simulation settings.
  const s = defaultSettings();
  const c = raw.config;
  if (c.StartTime) s.startTime = expr(c.StartTime);
  if (c.StopTime) s.stopTime = c.StopTime === 'inf' || c.StopTime === 'Inf' ? '10' : expr(c.StopTime);
  if (c.StopTime && /^inf$/i.test(c.StopTime)) warnings.push('Nekonečný čas simulácie sa nahradil hodnotou 10 s.');
  const solver = mapSolver(c.Solver ?? '', c.SolverType ?? '');
  if (solver.note) warnings.push(solver.note);
  s.solver = solver.name;
  if (c.FixedStep) s.fixedStep = expr(c.FixedStep);
  if (c.MaxStep) s.maxStep = expr(c.MaxStep);
  if (c.RelTol && c.RelTol !== 'auto') s.relTol = expr(c.RelTol);
  if (c.AbsTol && c.AbsTol !== 'auto') s.absTol = expr(c.AbsTol);
  model.settings = s;

  // Model callbacks often define the parameters; keep the ones our syntax understands.
  const ws: string[] = [];
  for (const cb of raw.callbacks) {
    try {
      compileScript(cb);
      ws.push(cb.trim());
    } catch {
      ws.push(cb.split('\n').map((l) => `% ${l}`).join('\n'));
      warnings.push('Časť kódu z callbackov modelu (PreLoadFcn/InitFcn) sa nedá spustiť, vložila sa do pracovného priestoru ako komentár.');
    }
  }
  model.workspace = ws.join('\n');

  for (const [kind, n] of unsupported) warnings.unshift(`Nepodporovaný blok „${kind}“ (${n}×) sa nahradil zástupným blokom s nulovým výstupom.`);
  return { model, warnings };
}

/** Mux "Inputs" may be a count or a list of widths like "[2 3]". */
function countSpec(s: string): string {
  const t = s.trim();
  if (t.startsWith('[')) return String(t.replace(/[[\]]/g, '').split(/[,\s;]+/).filter(Boolean).length || 1);
  return /^\d+$/.test(t) ? t : '2';
}

function mapSolver(solver: string, type: string): { name: SolverName; note?: string } {
  const direct: SolverName[] = ['ode45', 'ode23', 'ode23s', 'ode1', 'ode2', 'ode3', 'ode4', 'ode5'];
  if ((direct as string[]).includes(solver)) return { name: solver as SolverName };
  const map: Record<string, SolverName> = {
    ode8: 'ode5', ode14x: 'ode5', ode1be: 'ode1', ode113: 'ode45', ode15s: 'ode23s', ode23t: 'ode23s', ode23tb: 'ode23s',
    VariableStepAuto: 'ode45', VariableStepDiscrete: 'ode45', FixedStepAuto: 'ode3', FixedStepDiscrete: 'ode1',
  };
  if (map[solver]) {
    const silent = ['VariableStepAuto', 'VariableStepDiscrete', 'FixedStepAuto', 'FixedStepDiscrete'].includes(solver);
    return { name: map[solver], note: silent ? undefined : `Riešič ${solver} sa nahradil riešičom ${map[solver]}.` };
  }
  return { name: /Fixed/i.test(type) ? 'ode3' : 'ode45' };
}

/**
 * Block x/y hold Simulink block centres at this point. P-Sim blocks are drawn larger,
 * so centres are spread by a common factor before blocks are placed around them,
 * and the diagram (and each subsystem) is moved to start near the origin.
 */
const SPREAD = 1.6;
function normalizePositions(d: Diagram) {
  if (d.blocks.length) {
    for (const b of d.blocks) {
      const { w, h } = blockSize(b);
      b.x = b.x * SPREAD - w / 2;
      b.y = b.y * SPREAD - h / 2;
    }
    const minX = Math.min(...d.blocks.map((b) => b.x)), minY = Math.min(...d.blocks.map((b) => b.y));
    for (const b of d.blocks) {
      b.x = Math.round((b.x - minX + 40) / 5) * 5;
      b.y = Math.round((b.y - minY + 40) / 5) * 5;
    }
  }
  for (const b of d.blocks) if (b.children) normalizePositions(b.children);
}
