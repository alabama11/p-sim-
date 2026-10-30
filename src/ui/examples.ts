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

export const EXAMPLES: { title: string; make(): Model }[] = [
  { title: 'Systém 1. rádu – odozva na skok', make: firstOrder },
  { title: 'Kmitanie pružiny (hmotnosť, pružina, tlmič)', make: massSpring },
  { title: 'PID regulácia s obmedzením akčného zásahu', make: pidControl },
  { title: 'Vzorkovanie a oneskorenie (diskrétne bloky)', make: sampling },
  { title: 'Termostat (relé s hysteréziou)', make: thermostat },
];
