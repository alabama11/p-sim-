// Built-in example models for teaching.

import { ModelBuilder } from '../sim/build';
import type { Model } from '../sim/types';

function firstOrder(): Model {
  const m = new ModelBuilder('system_1_radu', { stopTime: '10' });
  const st = m.add('Step', 'Skok', { time: '1', before: '0', after: '1' }, 40, 100);
  const g = m.add('TransferFcn', 'Sústava', { num: '[1]', den: '[T 1]' }, 170, 97);
  const sc = m.add('Scope', 'Scope', { inputs: '2' }, 340, 98);
  m.model.workspace = 'T = 2   % časová konštanta [s]';
  m.connect(st, 0, g, 0).connect(g, 0, sc, 0).connect(st, 0, sc, 1);
  return m.model;
}

function massSpring(): Model {
  const m = new ModelBuilder('kmitanie_pruziny', { stopTime: '20' },
    'm = 1     % hmotnosť [kg]\nk = 4     % tuhosť pružiny [N/m]\nb = 0.4   % tlmenie [N·s/m]');
  const f = m.add('Step', 'Sila F', { time: '1' }, 30, 60);
  const sum = m.add('Sum', 'Súčet síl', { signs: '+--' }, 140, 51);
  const im = m.add('Gain', '1/m', { K: '1/m' }, 230, 60);
  const iv = m.add('Integrator', 'Rýchlosť v', {}, 340, 60);
  const ix = m.add('Integrator', 'Poloha x', {}, 460, 60);
  const sc = m.add('Scope', 'Scope', { inputs: '2' }, 600, 60);
  const gb = m.add('Gain', 'b', { K: 'b' }, 340, 170);
  const gk = m.add('Gain', 'k', { K: 'k' }, 460, 250);
  m.flip(gb).flip(gk);
  m.connect(f, 0, sum, 0).connect(sum, 0, im, 0).connect(im, 0, iv, 0).connect(iv, 0, ix, 0)
    .connect(ix, 0, sc, 0).connect(iv, 0, sc, 1)
    .connect(iv, 0, gb, 0).connect(gb, 0, sum, 1)
    .connect(ix, 0, gk, 0).connect(gk, 0, sum, 2);
  return m.model;
}

function pidControl(): Model {
  const m = new ModelBuilder('pid_regulacia', { stopTime: '15' });
  const ref = m.add('Step', 'Žiadaná hodnota', { time: '1' }, 30, 80);
  const sum = m.add('Sum', 'Odchýlka', { signs: '+-' }, 140, 80);
  const pid = m.add('PID', 'PID', { P: '3', I: '2', D: '0.5', N: '50' }, 230, 80);
  const sat = m.add('Saturation', 'Obmedzenie', { upper: '5', lower: '-5' }, 350, 80);
  const plant = m.add('TransferFcn', 'Sústava', { num: '[1]', den: '[1 3 2]' }, 460, 77);
  const sc = m.add('Scope', 'Scope', { inputs: '3' }, 640, 70);
  m.connect(ref, 0, sum, 0).connect(sum, 0, pid, 0).connect(pid, 0, sat, 0).connect(sat, 0, plant, 0)
    .connect(plant, 0, sc, 0).connect(ref, 0, sc, 1).connect(sat, 0, sc, 2).connect(plant, 0, sum, 1);
  return m.model;
}

function sampling(): Model {
  const m = new ModelBuilder('vzorkovanie', { stopTime: '10' });
  const sw = m.add('SineWave', 'Sínus', { frequency: '1' }, 40, 80);
  const zoh = m.add('ZeroOrderHold', 'Vzorkovač', { Ts: '0.5' }, 170, 140);
  const dl = m.add('UnitDelay', 'Oneskorenie', { Ts: '0.5' }, 290, 200);
  const sc = m.add('Scope', 'Scope', { inputs: '3' }, 430, 120);
  m.connect(sw, 0, sc, 0).connect(sw, 0, zoh, 0).connect(zoh, 0, sc, 1).connect(zoh, 0, dl, 0).connect(dl, 0, sc, 2);
  return m.model;
}

function thermostat(): Model {
  const m = new ModelBuilder('termostat', { stopTime: '120' },
    'Tset = 21    % žiadaná teplota [°C]\nTout = 5     % vonkajšia teplota [°C]\nKh = 30      % výkon kúrenia [°C]\ntau = 15     % časová konštanta miestnosti [s]');
  const set = m.add('Constant', 'Žiadaná', { value: 'Tset' }, 30, 60);
  const err = m.add('Sum', 'Odchýlka', { signs: '+-' }, 130, 60);
  const relay = m.add('Relay', 'Termostat', { on: '0.5', off: '-0.5', yon: '1', yoff: '0' }, 220, 65);
  const kh = m.add('Gain', 'Kúrenie', { K: 'Kh' }, 330, 65);
  const out = m.add('Constant', 'Vonku', { value: 'Tout' }, 330, 160);
  const add = m.add('Sum', 'Teplo', { signs: '++' }, 430, 80);
  const room = m.add('TransferFcn', 'Miestnosť', { num: '[1]', den: '[tau 1]' }, 520, 77);
  const sc = m.add('Scope', 'Scope', { inputs: '2' }, 690, 70);
  m.connect(set, 0, err, 0).connect(err, 0, relay, 0).connect(relay, 0, kh, 0).connect(kh, 0, add, 0)
    .connect(out, 0, add, 1).connect(add, 0, room, 0).connect(room, 0, sc, 0).connect(set, 0, sc, 1)
    .connect(room, 0, err, 1);
  return m.model;
}

/** The mass-spring-damper packed into a masked subsystem with parameters m, k, b. */
function maskedOscillator(): Model {
  const inner = new ModelBuilder('inner');
  const f = inner.add('Inport', 'F', { port: '1' }, 20, 66);
  const sum = inner.add('Sum', 'Súčet síl', { signs: '+--' }, 110, 51);
  const im = inner.add('Gain', '1/m', { K: '1/m' }, 200, 60);
  const iv = inner.add('Integrator', 'v', {}, 310, 60);
  const ix = inner.add('Integrator', 'x', {}, 430, 60);
  const out = inner.add('Outport', 'x', { port: '1' }, 560, 70);
  const gb = inner.add('Gain', 'b', { K: 'b' }, 310, 170);
  const gk = inner.add('Gain', 'k', { K: 'k' }, 430, 250);
  inner.flip(gb).flip(gk);
  inner.connect(f, 0, sum, 0).connect(sum, 0, im, 0).connect(im, 0, iv, 0).connect(iv, 0, ix, 0).connect(ix, 0, out, 0)
    .connect(iv, 0, gb, 0).connect(gb, 0, sum, 1).connect(ix, 0, gk, 0).connect(gk, 0, sum, 2);

  const m = new ModelBuilder('maskovany_oscilator', { stopTime: '20' });
  const st = m.add('Step', 'Sila', { time: '1' }, 40, 80);
  const s1 = m.add('Subsystem', 'Mäkká pružina', { m: '1', k: '1', b: '0.2' }, 180, 70);
  const s2 = m.add('Subsystem', 'Tuhá pružina', { m: '1', k: '6', b: '0.8' }, 180, 170);
  const sc = m.add('Scope', 'Scope', { inputs: '2' }, 380, 110);
  for (const id of [s1, s2]) {
    const b = m.model.blocks.find((x) => x.id === id)!;
    b.children = structuredClone({ blocks: inner.model.blocks, links: inner.model.links });
    b.mask = {
      title: 'Oscilátor',
      description: 'Teleso na pružine s tlmičom: m·x″ + b·x′ + k·x = F',
      params: [
        { name: 'm', label: 'Hmotnosť m [kg]', default: '1' },
        { name: 'k', label: 'Tuhosť k [N/m]', default: '4' },
        { name: 'b', label: 'Tlmenie b [N·s/m]', default: '0.4' },
      ],
    };
  }
  m.connect(st, 0, s1, 0).connect(st, 0, s2, 0).connect(s1, 0, sc, 0).connect(s2, 0, sc, 1);
  return m.model;
}

function stiffSystem(): Model {
  const m = new ModelBuilder('tuhy_system', { solver: 'ode23s', stopTime: '10' },
    'a = 1000   % rýchlosť sledovania (veľká = tuhý systém)');
  const clk = m.add('Clock', 'Čas', {}, 30, 60);
  const cos = m.add('MathFunction', 'cos', { fn: 'cos' }, 120, 62);
  const sum = m.add('Sum', 'Rozdiel', { signs: '+-' }, 230, 60);
  const g = m.add('Gain', 'a', { K: 'a' }, 320, 60);
  const x = m.add('Integrator', 'x', {}, 430, 60);
  const sc = m.add('Scope', 'Scope', {}, 560, 60);
  m.connect(clk, 0, cos, 0).connect(cos, 0, sum, 0).connect(x, 0, sum, 1).connect(sum, 0, g, 0)
    .connect(g, 0, x, 0).connect(x, 0, sc, 0);
  return m.model;
}

function vectorOscillators(): Model {
  const m = new ModelBuilder('vektorove_oscilatory', { stopTime: '10', relTol: '1e-6' },
    'k = [1 4 9]   % tri tuhosti naraz: jeden vektorový signál so 3 prvkami');
  const iv = m.add('Integrator', 'Rýchlosti v', { x0: '0' }, 160, 60);
  const ix = m.add('Integrator', 'Polohy x', { x0: '[1 1 1]' }, 290, 60);
  const sc = m.add('Scope', 'Polohy', {}, 470, 60);
  const gk = m.add('Gain', '-k', { K: '-k' }, 225, 160);
  const mux = m.add('Mux', 'Mux', { inputs: '2' }, 400, 230);
  const en = m.add('Fcn', 'Energia', { expr: '0.5*sum(k.*u(1:3).^2 + u(4:6).^2)' }, 450, 236);
  const se = m.add('Scope', 'Celková energia', {}, 600, 230);
  m.flip(gk);
  m.connect(iv, 0, ix, 0).connect(ix, 0, sc, 0).connect(ix, 0, gk, 0).connect(gk, 0, iv, 0)
    .connect(ix, 0, mux, 0).connect(iv, 0, mux, 1).connect(mux, 0, en, 0).connect(en, 0, se, 0);
  return m.model;
}

function tankLevel(): Model {
  const m = new ModelBuilder('hladina_v_nadrzi', { stopTime: '40' },
    'A = 1      % prierez nádrže [m²]\na = 0.5    % výtokový koeficient\nqmax = 2   % najväčší prítok [m³/s]');
  const ref = m.add('Step', 'Žiadaná hladina', { time: '15', before: '1', after: '2' }, 30, 60);
  const code = [
    '% Regulátor prítoku: naplno, zavrieť, alebo úmerne odchýlke',
    'e = u1 - u2;   % žiadaná mínus skutočná hladina',
    'if e > 0.2',
    '  y = qmax;',
    'elseif e < -0.2',
    '  y = 0;',
    'else',
    '  y = qmax/2 + 2.5*qmax*e;',
    'end',
  ].join('\n');
  const ctl = m.add('OctaveFcn', 'Regulátor', { code, inputs: '2', outputs: '1' }, 170, 70);
  const mux = m.add('Mux', 'Mux', { inputs: '2' }, 330, 66);
  const tank = m.add('Fcn', 'Nádrž dh/dt', { expr: '(u(1) - a*sqrt(max(u(2), 0)))/A' }, 380, 76);
  const h = m.add('Integrator', 'Hladina h', { x0: '0.2' }, 530, 73);
  const sc = m.add('Scope', 'Scope', { inputs: '3' }, 660, 70);
  m.connect(ref, 0, ctl, 0).connect(h, 0, ctl, 1).connect(ctl, 0, mux, 0).connect(h, 0, mux, 1)
    .connect(mux, 0, tank, 0).connect(tank, 0, h, 0)
    .connect(h, 0, sc, 0).connect(ref, 0, sc, 1).connect(ctl, 0, sc, 2);
  return m.model;
}

export const EXAMPLES: { title: string; make(): Model }[] = [
  { title: 'Systém 1. rádu – odozva na skok', make: firstOrder },
  { title: 'Kmitanie pružiny (hmotnosť, pružina, tlmič)', make: massSpring },
  { title: 'PID regulácia s obmedzením akčného zásahu', make: pidControl },
  { title: 'Vzorkovanie a oneskorenie (diskrétne bloky)', make: sampling },
  { title: 'Termostat (relé s hysteréziou)', make: thermostat },
  { title: 'Maskovaný subsystém: dva oscilátory', make: maskedOscillator },
  { title: 'Tuhý systém (riešič ode23s)', make: stiffSystem },
  { title: 'Vektorové signály: tri oscilátory naraz', make: vectorOscillators },
  { title: 'Octave Function: regulácia hladiny v nádrži', make: tankLevel },
];
