## Werdykt ogólny

Kod fizyki jest już znacznie bardziej „fizyczny” niż typowe arcade’owe symulatory: masz metry, kilogramy, radiany, osobne osie, transfer masy, model opon, ERS, ślad aerodynamiczny, podkroki zawieszenia i osobny resolver kolizji. To widać w `Car.ts` i `Traffic.ts`.

Największe problemy nie wynikają z braku modeli, tylko z **niespójności jednostek, stanów i flag**, a także z **alokacji w pętli fizyki**. Poniżej konkretny audyt.

---

# 1. Krytyczne błędy i niespójności fizyczne

## 1.1. `minCenterClearance` nie jest wyrażone w metrach

W `Car.planDrive()` masz:

```ts
const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * (76 / Math.max(5, track.width));
```

Problem:

- `this.rayDistances` są znormalizowane przez `Car.RAY_MAX_DIST = 240`, czyli są w jednostkach `0..1`.
- Mnożnik `76 / track.width` jest empiryczny i zależy od szerokości toru.
- Progi `0.22` i `0.12` nie mają jasnej interpretacji fizycznej.
- Dla toru 14 m i 20 m ten sam kąt/odległość daje różne wartości `minCenterClearance`.

To powoduje, że AI inaczej reaguje na ścianę w zależności od szerokości toru, mimo że fizycznie przeszkoda jest w metrach.

### Poprawka

Używaj metrów, nie znormalizowanych wartości:

```ts
// Teraz:
const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * (76 / Math.max(5, track.width));

// Lepiej:
const minRayMeters = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * Car.RAY_MAX_DIST;

// Teraz minCenterClearance jest w metrach.
// Progi też powinny być w metrach, np.:
// - poniżej 1.5 m: bardzo blisko bandy,
// - poniżej 3.0 m: strefa ochronna,
// - powyżej 3.0 m: normalna jazda.
const minCenterClearance = minRayMeters;
```

W `planDrive()` zamień progi:

```ts
// Teraz:
if (minCenterClearance > 0.22) { ... }
else if (minCenterClearance > 0.12) { ... }

// Lepiej:
if (minCenterClearance > 3.0) {
  // normalna jazda
} else if (minCenterClearance > 1.5) {
  // strefa ochronna
} else {
  // awaryjne hamowanie
}
```

---

## 1.2. `stepSuspension()` nie jest odporne na `NaN` i duże `dt`

W `stepSuspension()` masz:

```ts
const travel = dt * Math.max(1, this.speed) / 2.5;
```

Jeśli `this.speed` stanie się `NaN`, to:

```ts
Math.max(1, NaN) === NaN
```

a potem:

```ts
const follow = 1 - Math.exp(-4 * travel);
```

też daje `NaN`. To zakaża `roadFront`, `roadRear`, `heave`, `pitch`, `roll`, a potem całą telemetrię.

### Poprawka

```ts
const speedSafe = Number.isFinite(this.speed) ? Math.max(0, this.speed) : 0;

// Ogranicz travel do [0, 1], żeby przy dużym kroku nie było absurdalnych skoków.
const travel = Math.min(1, dt * speedSafe / 2.5);

const follow = 1 - Math.exp(-4 * travel);

this.roadFront += (this.roadTargetFront - this.roadFront) * follow;
this.roadRear += (this.roadTargetRear - this.roadRear) * follow;

// Ochrona przed NaN
if (!Number.isFinite(this.roadFront)) this.roadFront = 0;
if (!Number.isFinite(this.roadRear)) this.roadRear = 0;
```

---

## 1.3. `SUSPENSION_ROLL = false` nie przywraca starego statycznego transferu

Dokumentacja mówi, że `SUSPENSION_ROLL = false` ma przywrócić statyczny podział transferu bocznego przez `ROLL_STIFFNESS_FRONT`.

Ale kod nadal integruje `this.roll` i `this.rollRate`, a potem używa ich w:

```ts
this.rollTransferFront = (kRollF * this.roll + cRollF * this.rollRate) / this.trackWidthMeters + unsprung * 0.46;
this.rollTransferRear = (kRollF * this.roll + cRollR * this.rollRate) / this.trackWidthMeters + unsprung * 0.54;
```

Czyli flaga `SUSPENSION_ROLL` nie zmienia zachowania w sposób, który obiecuje dokumentacja.

### Poprawka

Jeśli `SUSPENSION_ROLL === false`, użyj statycznego transferu z bieżącego `lateralG`:

```ts
if (Car.SUSPENSION_ROLL) {
  this.rollTransferFront = (kRollF * this.roll + cRollF * this.rollRate) / this.trackWidthMeters + unsprung * 0.46;
  this.rollTransferRear = (kRollR * this.roll + cRollR * this.rollRate) / this.trackWidthMeters + unsprung * 0.54;
} else {
  const staticTransfer = this.totalMass * this.lateralG * Car.GRAVITY * this.cogHeight / this.trackWidthMeters;

  this.rollTransferFront = staticTransfer * Car.ROLL_STIFFNESS_FRONT;
  this.rollTransferRear = staticTransfer * (1 - Car.ROLL_STIFFNESS_FRONT);
}
```

---

## 1.4. `SUSPENSION_LOADS` i `SUSPENSION_ROLL` są sprzężone, ale nie spójne

W `updatePhysics()` masz:

```ts
if (Car.SUSPENSION_DYNAMIC && Car.SUSPENSION_LOADS) {
  const anti = this.longitudinalG < 0 ? Car.ANTI_DIVE : Car.ANTI_SQUAT;
  const direct = pitchTransfer * (1 - Car.SPRUNG_MASS_SHARE + Car.SPRUNG_MASS_SHARE * anti);
  const front = gravityForce * 0.46 + this.suspensionForceFront + direct;
  const rear = gravityForce * 0.54 + this.suspensionForceRear - direct;
  ...
}
```

To jest OK, ale `this.suspensionForceFront` i `this.suspensionForceRear` są liczone w `stepSuspension()`, które z kolei używa `this.lateralG` z poprzedniego kroku.

To wprowadza **jednokrokowe opóźnienie transferu bocznego**. Przy 60 Hz to zwykle akceptowalne, ale przy 30 Hz lub przy gwałtownych zmianach kierunku może powodować sztuczne „opóźnienie” reakcji opon.

### Rekomendacja

Jeśli chcesz zachować deterministyczność i stabilność, zostaw jedno-krokowe opóźnienie, ale udokumentuj je. Jeśli chcesz bardziej fizyczne zachowanie, użyj predykcji `lateralG` na następny krok:

```ts
const predictedLateralG = this.lateralG + (this.lateralG - this.lastLateralG) * 0.5;
this.stepSuspension(dt, aeroFront, downRear, this.longitudinalG * Car.GRAVITY, predictedLateralG * Car.GRAVITY);
```

ale to już wymaga ostrożności, bo może wprowadzić oscylacje.

---

## 1.5. `PORPOISING` i `floorStall` są liczone, ale domyślnie wyłączone

W kodzie masz:

```ts
public static PORPOISING = false;
```

ale `floorStall` i `porpoisingHz` są aktualizowane. To nie jest błąd, ale utrudnia testy.

### Rekomendacja

W testach i diagnostyce uruchamiaj osobny tryb:

```ts
Car.PORPOISING = true;
Car.PORPOISING_STALL_LOSS = 0.4;
```

a w produkcji domyślnie `false`, jeśli nie chcesz chaosu w treningu.

---

## 1.6. `PLANK_CONTACT` i `PLANK_FRICTION` są liczone, ale `plankForce` nie jest ograniczane

W `stepSuspension()`:

```ts
const plank = (gap: number, closing: number) => gap >= 0 || !Car.PLANK_CONTACT ? 0
  : Math.max(0, Car.PLANK_STIFFNESS * -gap + Car.PLANK_DAMPING * Math.max(0, closing));
```

To jest OK, ale `plankForce` może stać się bardzo duże przy gwałtownym dobiciu. Potem:

```ts
const plankDrag = Car.SUSPENSION_DYNAMIC ? Car.PLANK_FRICTION * this.plankForce : 0;
```

Jeśli `plankForce` jest duże, `plankDrag` może nagle dodać dużą siłę hamującą.

### Rekomendacja

Ogranicz `plankForce` do fizycznie sensownej wartości, np. 10–20 kN:

```ts
this.plankForce = Math.min(pf + pr, 20000);
```

albo:

```ts
const maxPlankForce = 20000;
this.plankForce = Math.min(pf + pr, maxPlankForce);
```

---

## 1.7. `dragScale` i `resistanceScale` mogą być zbyt agresywne przy małych prędkościach

Masz:

```ts
const dragScale = speedMag > 0 ? Math.min(dragMagnitude / speedMag, currentMass / dt) : 0;
```

oraz:

```ts
const resistanceScale = resistance > 0 ? Math.min(1, currentMass * Math.abs(vStar) / (dt * resistance)) : 0;
```

To jest dobra ochrona przed „odwróceniem” prędkości w jednym kroku, ale przy `speedMag` bliskim 0 i dużym hamowaniu może powodować skoki.

### Rekomendacja

Dodaj dolny próg i limit:

```ts
const minSpeedForDrag = 0.5;

const dragScale = speedMag > minSpeedForDrag
  ? Math.min(dragMagnitude / speedMag, currentMass / dt)
  : 0;

const resistanceScale = resistance > 0
  ? Math.min(1, currentMass * Math.abs(vStar) / (dt * resistance))
  : 0;
```

---

## 1.8. `engineBrakeForce` jest dodawane tylko do tylnej osi

W kodzie:

```ts
const engineBrakeForce = actualThrottle < 0.02 && control.brake <= 0.02
  ? (45 + 25 * this.engineRpm / Car.REV_LIMIT) * Car.GEAR_RATIOS[this.gear] / Car.WHEEL_RADIUS * Math.min(1, Math.abs(forwardSpeed) / 5)
  : 0;
```

a potem:

```ts
const rollingRear = Math.min(rearLimit, 0.012 * rearLoad + engineBrakeForce);
```

To jest fizycznie poprawne dla napędu na tył. Ale jeśli kiedyś dodasz napęd na przód lub hybrydę z przodem, trzeba to rozdzielić.

### Rekomendacja

Zrób funkcję:

```ts
private engineBrakeForceForAxle(load: number, isDrivenAxle: boolean): number {
  if (!isDrivenAxle) return 0;
  ...
}
```

---

## 1.9. `brakeDemand` nie uwzględnia znaku prędkości

Masz:

```ts
const brakeDemand = control.brake * (frontLimit + rearLimit);
```

a potem:

```ts
const resistanceSign = Math.sign(vStar);
```

To jest OK, ale `brakeDemand` jest zawsze dodatnie. Jeśli `vStar` jest ujemne, `resistanceSign` odwraca kierunek hamowania. To działa, ale jest nieczytelne.

### Rekomendacja

Zrób jawne hamowanie z uwzględnieniem kierunku:

```ts
const brakeDirection = Math.sign(vStar) || 1;
const brakeForce = control.brake * (frontLimit + rearLimit) * brakeDirection;
```

---

## 1.10. `driveForce` nie jest ograniczane przez `frontLimit`

Masz:

```ts
const driveForce = Math.min(Math.max(0, rearLongLimit - rollingRear), engineForce);
```

To jest OK, bo napęd jest na tylnej osi. Ale jeśli kiedyś dodasz napęd na przód, trzeba będzie rozdzielić `driveForceFront` i `driveForceRear`.

---

# 2. Model aerodynamiczny

## 2.1. Docisk jest liczony od `speedMag`, nie od `forwardSpeed`

W kodzie:

```ts
let downforceMag = 0.5 * this.airDensity * this.downforceCoeff * (1 - 0.35 * this.damage) * (speedMag * speedMag);
```

To jest fizycznie poprawne, jeśli nie ma bocznego wiatru. Docisk zależy od kwadratu prędkości względem powietrza.

Ale jeśli samochód jedzie bokiem, `speedMag` jest większe niż `forwardSpeed`, więc docisk rośnie. To może być realistyczne, ale trzeba to udokumentować.

### Rekomendacja

Jeśli chcesz modelować spadek docisku przy bocznym kącie natarcia, użyj:

```ts
const aerodynamicSpeed = Math.max(0, this.vel.dot(newForwardDir));
```

albo:

```ts
const aerodynamicSpeed = Math.max(0, this.vel.dot(newForwardDir));
const downforceMag = 0.5 * this.airDensity * this.downforceCoeff * (1 - 0.35 * this.damage) * aerodynamicSpeed * aerodynamicSpeed;
```

---

## 2.2. Brak DRS

Nie ma flagi DRS. To ograniczenie realizmu.

### Rekomendacja

Dodaj:

```ts
public static DRS_ACTIVE = false;
public static D_DRAG_REDUCTION = 0.15;
```

i w `dragMagnitude`:

```ts
const dragFactor = this.drsActive ? (1 - Car.D_DRAG_REDUCTION) : 1;
```

---

## 2.3. Brak wiatru

Brak wiatru to duże uproszczenie. Wiatr zmienia:

- opór,
- docisk,
- boczne obciążenie,
- stabilność.

### Rekomendacja

Dodaj globalny wektor wiatru:

```ts
export const WIND_VECTOR = new Vector2(0, 0);
```

albo:

```ts
public static WIND_SPEED = 0;
public static WIND_DIRECTION = 0;
```

---

# 3. Model opon

## 3.1. Temperatura i zużycie są liczone na osie, nie na koła

To jest rozsądne uproszczenie, ale powoduje, że nie da się modelować:

- różnego obciążenia lewego/prawego koła,
- różnego zużycia przód/tył,
- różnego zużycia lewy/prawy.

### Rekomendacja

Jeśli chcesz większy realizm, rozszerz model do 4 kół:

```ts
tyreTempFL, tyreTempFR, tyreTempRL, tyreTempRR
tyreWearFL, tyreWearFR, tyreWearRL, tyreWearRR
```

---

## 3.2. `TYRE_TRACK` jest stałe

W `stepTyre()`:

```ts
const cooling = 2 * (15 + 3.2 * Math.max(0, speed) ** 0.8) * (temp - Car.TYRE_AMBIENT) + 60 * (temp - Car.TYRE_TRACK);
```

`TYRE_TRACK` jest stałe, ale w rzeczywistości temperatura toru zmienia się z:

- porą dnia,
- pogodą,
- liczbą przejazdów,
- rodzajem asfaltu.

### Rekomendacja

Dodaj dynamiczny stan toru:

```ts
public static trackTemperature = 38;
```

albo w `Track`:

```ts
track.getSurfaceTemperature(position)
```

---

## 3.3. `TYRE_HEAT_SCALE`, `TYRE_FRONT_HEAT`, `TYRE_LAT_HEAT`, `TYRE_LONG_HEAT` są kalibracyjne

To nie są błędy, ale bez testów regresyjnych łatwo je zepsuć.

### Rekomendacja

Dodaj testy:

- stała prędkość prosta,
- stały zakręt,
- hamowanie,
- przyspieszanie,
- porównanie 30/60/120 Hz.

---

# 4. Układ napędowy i skrzynia

## 4.1. `stepGearbox()` używa `forwardSpeed`, ale po kolizji może być nieaktualne

W `updatePhysics()` `this.speed` jest aktualizowane po kolizji. Ale `stepGearbox()` jest wywoływane przed aktualizacją `this.speed`.

To nie jest krytyczne, ale powoduje, że obroty silnika są liczone z prędkości z poprzedniego kroku.

### Rekomendacja

Jeśli chcesz większej stabilności, przenieś aktualizację `this.speed` przed `stepGearbox()` albo użyj `vStar`.

---

## 4.2. Brak rzeczywistego momentu obrotowego silnika

Masz model mocy:

```ts
engineForce = power / speed
```

To jest dobre uproszczenie, ale nie modeluje:

- momentu obrotowego,
- inercji kół,
- inercji układu napędowego,
- wheel spinu.

### Rekomendacja

Dodaj:

```ts
engineTorque(rpm)
wheelInertia
drivetrainInertia
```

---

## 4.3. Brak DRS i brak zmiany przełożeń w czasie rzeczywistym

Skrzynia działa, ale nie ma:

- shift-up/down delay,
- torque interruption,
- rev matching,
- brake bias.

---

# 5. Całka czasowa i pętla symulacji

## 5.1. Brak wymuszonego stałego kroku w `Car.updatePhysics()`

`Car.updatePhysics()` przyjmuje `dt`, ale nie pilnuje, żeby `dt` było stałe.

Jeśli worker wywoła `updatePhysics` z różnym `dt`, wyniki będą zależne od framerate’u.

### Rekomendacja

W workerze użyj akumulatora:

```ts
let accumulator = 0;
const FIXED_DT = 1 / 60;

function frame(realDt: number) {
  accumulator += realDt;

  while (accumulator >= FIXED_DT) {
    car.updatePhysics(control, FIXED_DT, track);
    accumulator -= FIXED_DT;
  }
}
```

---

## 5.2. `SUSPENSION_SUBSTEP = 1/240` jest dobrym pomysłem

To jest poprawne. Ale jeśli `dt` jest większe niż `SUSPENSION_SUBSTEP`, `stepSuspension()` robi podkroki. To dobrze.

Problem: jeśli `dt` jest bardzo duże, np. 0.25 s, to `travel` w road roughness może być > 1.

### Poprawka

```ts
const travel = Math.min(1, dt * speedSafe / 2.5);
```

---

## 5.3. Brak globalnego substeppingu fizyki

Zawieszenie ma substepping, ale cały model fizyczny nie.

Przy 30 Hz i prędkości 100 m/s samochód przesuwa się o 3.33 m na krok. To dużo.

### Rekomendacja

Dodaj substepping dla całego `updatePhysics()`:

```ts
const PHYSICS_SUBSTEPS = 4;
const subDt = dt / PHYSICS_SUBSTEPS;

for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
  this.updatePhysics(control, subDt, track);
}
```

albo w workerze.

---

# 6. Wydajność w przeglądarce

## 6.1. `this.currentControl = { ...control }` alokuje obiekt co krok

To generuje garbage.

### Poprawka

```ts
this.currentControl.steer = control.steer;
this.currentControl.throttle = control.throttle;
this.currentControl.brake = control.brake;
```

albo:

```ts
this.currentControl = control;
```

jeśli `control` nie jest modyfikowane.

---

## 6.2. `this.surfaceFractions = fractions` alokuje obiekt co krok

### Poprawka

```ts
this.surfaceFractions.asphalt = fractions.asphalt;
this.surfaceFractions.grass = fractions.grass;
this.surfaceFractions.gravel = fractions.gravel;
```

albo:

```ts
this.surfaceFractions = this._surfaceFractionsScratch;
```

---

## 6.3. `this.rayHits = []` i `this.rayDistances = []` alokują tablice co krok

W `updateSensors()`:

```ts
this.rayHits = [];
this.rayDistances = [];
```

To jest kosztowne.

### Poprawka

```ts
this.rayHits.length = 0;
this.rayDistances.length = 0;
```

albo prealokuj:

```ts
this.rayDistances = new Array(rayCount).fill(1);
```

---

## 6.4. `this.replayBuffer.shift()` jest O(n)

Przy 50 elementach to nie jest dramat, ale przy 100+ już tak.

### Poprawka

Użyj ring buffer:

```ts
private replayBuffer: ReplaySample[] = [];
private replayHead = 0;
private readonly replayCapacity = 50;
```

---

## 6.5. `this.skidMarks.push(this.pos.clone())` alokuje Vector2

### Poprawka

Ring buffer z prealokowanymi punktami:

```ts
private readonly skidRing = new Float32Array(60 * 2);
private skidHead = 0;
```

---

## 6.6. `this.currentLapTrajectory.push(...)` alokuje obiekty

### Poprawka

Prealokuj tablicę i nadpisuj rekordy.

---

## 6.7. `this.currentLapSplits` i `bestLapSplits` są alokowane przy restarcie

To nie jest krytyczne, ale można użyć `fill(null)`.

---

# 7. Architektura

## 7.1. `Car.ts` jest zbyt duży

Obecnie `Car.ts` łączy:

- fizykę,
- AI,
- telemetrię,
- kolizje,
- pit stopy,
- pressure,
- mistakes,
- battle push,
- line search,
- line net.

To utrudnia testy i utrzymanie.

### Rekomendacja

Rozdziel na moduły:

```text
physics/
  VehicleDynamics.ts
  TireModel.ts
  Aerodynamics.ts
  SuspensionModel.ts
  Drivetrain.ts
  CollisionResolver.ts

ai/
  Planner.ts
  Guardian.ts
  LineNet.ts
  PaceSearch.ts

telemetry/
  Telemetry.ts
```

---

## 7.2. Statyczne flagi w klasie `Car` są globalnym stanem

Flagi:

```ts
Car.SUSPENSION_DYNAMIC
Car.SUSPENSION_ROLL
Car.PORPOISING
Car.WAKE_AERO
```

są globalne. To utrudnia testy równoległe.

### Rekomendacja

Zamień na konfigurację:

```ts
interface PhysicsConfig {
  suspensionDynamic: boolean;
  suspensionRoll: boolean;
  wakeAero: boolean;
  ...
}
```

---

## 7.3. `Traffic.ts` miesza kolizje, AI i telemetrię

`Traffic.avoidTraffic()` zmienia `car.replayBuffer`, `battlePush`, `battleOpponent`. To nie powinno być w resolverze kolizji.

### Rekomendacja

`Traffic.ts` powinien tylko wykrywać kolizje i aplikować impulsy.

Logika AI powinna być w `Planner.ts`.

---

# 8. Propozycje poprawek kodu

## 8.1. Zmiana `minCenterClearance` na metry

```ts
// Teraz:
const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * (76 / Math.max(5, track.width));

// Po zmianie:
const minRayMeters = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * Car.RAY_MAX_DIST;

// Teraz minCenterClearance jest w metrach.
const minCenterClearance = minRayMeters;
```

Progi:

```ts
// Teraz:
if (minCenterClearance > 0.22) { ... }
else if (minCenterClearance > 0.12) { ... }

// Po zmianie:
if (minCenterClearance > 3.0) { ... }
else if (minCenterClearance > 1.5) { ... }
```

---

## 8.2. Zabezpieczenie `stepSuspension()` przed `NaN`

```ts
const speedSafe = Number.isFinite(this.speed) ? Math.max(0, this.speed) : 0;
const travel = Math.min(1, dt * speedSafe / 2.5);

const follow = 1 - Math.exp(-4 * travel);

this.roadFront += (this.roadTargetFront - this.roadFront) * follow;
this.roadRear += (this.roadTargetRear - this.roadRear) * follow;

if (!Number.isFinite(this.roadFront)) this.roadFront = 0;
if (!Number.isFinite(this.roadRear)) this.roadRear = 0;
```

---

## 8.3. Statyczny transfer przy `SUSPENSION_ROLL = false`

```ts
if (Car.SUSPENSION_ROLL) {
  this.rollTransferFront = (kRollF * this.roll + cRollF * this.rollRate) / this.trackWidthMeters + unsprung * 0.46;
  this.rollTransferRear = (kRollR * this.roll + cRollR * this.rollRate) / this.trackWidthMeters + unsprung * 0.54;
} else {
  const staticTransfer = this.totalMass * this.lateralG * Car.GRAVITY * this.cogHeight / this.trackWidthMeters;

  this.rollTransferFront = staticTransfer * Car.ROLL_STIFFNESS_FRONT;
  this.rollTransferRear = staticTransfer * (1 - Car.ROLL_STIFFNESS_FRONT);
}
```

---

## 8.4. Reuse obiektów w `updatePhysics()`

Zamiast:

```ts
this.currentControl = { ...control };
```

użyj:

```ts
this.currentControl.steer = control.steer;
this.currentControl.throttle = control.throttle;
this.currentControl.brake = control.brake;
```

Zamiast:

```ts
this.surfaceFractions = fractions;
```

użyj:

```ts
this.surfaceFractions.asphalt = fractions.asphalt;
this.surfaceFractions.grass = fractions.grass;
this.surfaceFractions.gravel = fractions.gravel;
```

---

## 8.5. Ring buffer dla `skidMarks`

Zamiast:

```ts
this.skidMarks.push(this.pos.clone());
```

użyj:

```ts
this.skidRing[this.skidHead * 2] = this.pos.x;
this.skidRing[this.skidHead * 2 + 1] = this.pos.y;
this.skidHead = (this.skidHead + 1) % 60;
```

---

# 9. Lista ulepszeń od najważniejszych do opcjonalnych

## Krytyczne

1. **Przenieś `minCenterClearance` na metry.**
2. **Dodaj ochronę przed `NaN` w `stepSuspension()`.**
3. **Napraw `SUSPENSION_ROLL = false`, żeby faktycznie przywracało statyczny transfer.**
4. **Dodaj substepping dla całego `updatePhysics()`, nie tylko zawieszenia.**
5. **Zredukuj alokacje w pętli fizyki.**
6. **Dodaj testy regresyjne dla 30/60/120 Hz.**

## Ważne

7. **Dodaj DRS.**
8. **Dodaj wiatr.**
9. **Dodaj mapę temperatury toru.**
10. **Rozdziel model opon na 4 koła.**
11. **Dodaj model slip ratio dla osi napędowej.**
12. **Dodaj model hamowania silnikiem z uwzględnieniem bezwładności kół.**
13. **Dodaj brake bias i brake balance.**
14. **Dodaj limit `plankForce`.**
15. **Dodaj limit `lateralG` i `longitudinalG` przed użyciem w zawieszeniu.**

## Opcjonalne

16. **Dodaj model porpoisingu jako osobny moduł.**
17. **Dodaj model flexi-wing / flexi floor.**
18. **Dodaj model degradacji aerodynamicznej.**
19. **Dodaj model temperatury hamulców.**
20. **Dodaj model zużycia ERS w czasie.**
21. **Dodaj model DRS z opóźnieniem aktywacji.**
22. **Dodaj model track limit z 3D pozycją kół.**
23. **Dodaj model kolizji z deformacją i odbiciem.**
24. **Dodaj model aerodynamiczny zależny od kąta natarcia.**
25. **Dodaj model wiatru bocznego.**

---

# 10. Podsumowanie

Najważniejsze problemy to:

1. **Niespójność jednostek w `minCenterClearance`.**
2. **Brak ochrony przed `NaN` w `stepSuspension()`.**
3. **`SUSPENSION_ROLL = false` nie działa zgodnie z dokumentacją.**
4. **Zbyt wiele alokacji w pętli fizyki.**
5. **Brak globalnego substeppingu fizyki.**
6. **Brak DRS, wiatru i mapy toru.**

Po tych poprawkach symulator będzie znacznie stabilniejszy numerycznie i bardziej przewidywalny dla AI.
