# P-Sim

Webový simulátor blokových diagramov na výučbu spojitých a diskrétnych dynamických systémov.
Model sa kreslí z blokov v prehliadači a simuluje sa priamo v ňom, bez inštalácie.

> Funkcionalita je inšpirovaná nástrojmi na modelovanie pomocou blokových diagramov.
> Projekt neobsahuje kód, dokumentáciu, názvy produktov, logá ani ikony žiadnej tretej strany.

## Čo vie prototyp (verzia 0.1)

- **Editor:** knižnica blokov, ťahanie na plátno, prepájanie čiar vrátane odbočiek, posun a zoom,
  výber viacerých blokov, kopírovanie a vkladanie, späť/znova, automatické ukladanie v prehliadači,
  uloženie a otvorenie súboru `.psim` (JSON).
- **21 blokov:** Constant, Step, Ramp, Sine Wave, Pulse Generator, Clock, Gain, Sum, Product, Function,
  Integrator, Transfer Fcn, PID Controller, Unit Delay, Zero-Order Hold, Discrete-Time Integrator,
  Saturation, Relay, Switch, Scope, Display.
- **Riešiče:** premenlivý krok ode45 (Dormand-Prince) a ode23 (Bogacki-Shampine), pevný krok ode1 až ode5.
  Krok sa skracuje tak, aby presne zasiahol vzorkovacie okamihy a skoky zdrojov.
- **Diskrétne bloky** s vlastnou periódou vzorkovania (viac period v jednom modeli).
- **Parametre ako výrazy** v syntaxi podobnej Octave (`2*pi*f`, `[1 2 1]`, `sqrt(k/m)`) a pracovný priestor
  s premennými modelu.
- **Kontroly:** algebraické slučky, nepripojené vstupy, chybné parametre (blok sa zvýrazní).
- **Scope:** graf s priblížením, legendou a exportom do CSV.
- **5 ukážkových modelov:** systém 1. rádu, kmitanie pružiny, PID regulácia, vzorkovanie, termostat.

## Vývoj

```bash
npm install
npm run dev          # vývojový server
npm test             # testy simulačného jadra
npm run build        # produkčný build do dist/
npm run build:single # jeden samostatný súbor dist/index.html
```

## Štruktúra

- `src/sim/` – simulačné jadro bez závislosti na UI: výrazy (`expr.ts`), bloky (`blocks.ts`),
  riešiče (`solvers.ts`), kompilácia a simulácia (`engine.ts`).
- `src/ui/` – editor v Reacte: plátno, knižnica, dialógy, okno Scope, príklady.

## Ďalšie kroky

Vektorové signály a Mux/Demux, subsystémy a masky, detekcia prechodov nulou, tuhé riešiče,
import modelov `.mdl`/`.slx`, bloky v Pythone, stavové automaty.
