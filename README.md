# P-Sim

Webový simulátor blokových diagramov na výučbu spojitých a diskrétnych dynamických systémov.
Model sa kreslí z blokov v prehliadači a simuluje sa priamo v ňom, bez inštalácie.

> Funkcionalita je inšpirovaná nástrojmi na modelovanie pomocou blokových diagramov.
> Projekt neobsahuje kód, dokumentáciu, názvy produktov, logá ani ikony žiadnej tretej strany.

## Čo vie P-Sim (verzia 0.3)

- **Editor:** knižnica blokov, ťahanie na plátno, prepájanie čiar vrátane odbočiek, posun a zoom,
  výber viacerých blokov, kopírovanie a vkladanie, späť/znova, automatické ukladanie v prehliadači,
  uloženie a otvorenie súboru `.psim` (JSON).
- **Import modelov Simulinku** `.slx` aj `.mdl` (klasický textový aj novší balený formát): bloky, čiary
  s odbočkami, subsystémy, masky, predvolené parametre, nastavenia riešiča a premenné z callbackov modelu.
  Bloky bez náprotivku sa nahradia zástupcom a import vypíše zoznam rozdielov.
- **Vektorové signály:** `Constant [1 2 3]`, Mux a Demux, bloky pracujú po prvkoch a skalár sa rozšíri
  na vektor; šírky sa odvodia automaticky aj cez spätné väzby, vektorová čiara je hrubšia a ukazuje počet prvkov.
- **Vlastný kód v syntaxi Octave:** blok Fcn (výraz z `u` a `t`) a blok Octave Function (program s `if`,
  `for`, `while`, viac vstupov a výstupov). Rovnaký jazyk slúži aj pre pracovný priestor.
- **37 blokov:** Constant, Step, Ramp, Sine Wave, Pulse Generator, Clock, Random Number, Gain, Sum, Product,
  Function, MinMax, Relational Operator, Logical Operator, Integrator, Transfer Fcn, PID Controller, Derivative,
  Transport Delay, Unit Delay, Zero-Order Hold, Discrete-Time Integrator, Discrete Transfer Fcn, Saturation,
  Dead Zone, Relay, Switch, Mux, Demux, Fcn, Octave Function, Subsystem, In, Out, Scope, Display, Terminator.
- **Riešiče:** premenlivý krok ode45 (Dormand-Prince) a ode23 (Bogacki-Shampine), pre tuhé systémy ode23s
  (Rosenbrock), pevný krok ode1 až ode5. Krok sa skracuje tak, aby presne zasiahol vzorkovacie okamihy
  a skoky zdrojov.
- **Detekcia prechodov nulou:** Saturation, Dead Zone, Relay, Switch, Relational Operator, abs a sign
  prepnú presne v okamihu prechodu.
- **Subsystémy a masky:** vnorené subsystémy s blokmi In/Out, vytvorenie z výberu (Ctrl+G), navigácia,
  maska s vlastnými parametrami (Ctrl+M), ktoré sú vo vnútri dostupné ako premenné.
- **Zrkadlenie blokov** (Ctrl+I) pre prehľadné spätné väzby.
- **Diskrétne bloky** s vlastnou periódou vzorkovania (viac period v jednom modeli).
- **Parametre ako výrazy** v syntaxi podobnej Octave (`2*pi*f`, `[1 2 1]`, `0:0.1:1`, `v(2)`, porovnania
  a logické operátory) a pracovný priestor s premennými modelu (aj s cyklami a podmienkami).
- **Kontroly:** algebraické slučky, nepripojené vstupy, chybné parametre (blok sa zvýrazní).
- **Scope:** graf s priblížením, legendou a exportom do CSV.
- **9 ukážkových modelov:** systém 1. rádu, kmitanie pružiny, PID regulácia, vzorkovanie, termostat,
  maskovaný subsystém, tuhý systém, tri oscilátory ako jeden vektor, regulácia hladiny blokom Octave Function.

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
  rozbalenie subsystémov (`flatten.ts`), riešiče (`solvers.ts`), kompilácia a simulácia (`engine.ts`).
- `src/io/` – import modelov Simulinku: čítanie ZIP (`zip.ts`), XML (`xml.ts`) a prevod (`simulink.ts`).
- `src/ui/` – editor v Reacte: plátno, knižnica, dialógy, okno Scope, príklady.

## Ďalšie kroky

Bloky v Pythone (Pyodide), simulácia vo Web Workeri, stavové automaty, export do `.slx`,
signály s menami a zbernice.
