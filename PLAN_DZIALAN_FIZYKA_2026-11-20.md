# Plan działania po audycie fizyki — 2026-11-20

Dotyczy pliku `AUDYT_FIZYKI_2026-11-20.md`, stan kodu z commita `55b341e`.

**W skrócie:** z czterech punktów audytu najpoważniejszy okazał się punkt 2, który audyt opisał tylko jako hipotezę. Sonda numeryczna potwierdziła skok w przejściu z modelu kinematycznego w dynamiczny przy 8 m/s. Przez ten skok auto przy 0,37 g zgłasza poślizg w 52 z 60 kroków, a opony zaczynają się grzać zamiast stygnąć. Punkt 1 jest trafny tylko częściowo: audyt pominął najważniejszą rozbieżność (wiatr czołowy i w plecy), a przecenił mniej istotne. Punkt 3 rozstrzyga konstrukcja kodu: każda oś mieści się w swoim kole tarcia. Test warto dodać jako zabezpieczenie na przyszłość. Punkt 4 to uczciwie opisane ograniczenie. Bez danych referencyjnych nie da się go dziś naprawić, można je tylko zmierzyć.

Proponowana kolejność: **Etap 1** (przejście kinematyka → dynamika) → **Etap 2** (wiatr i aquaplaning w planiście) → **Etap 4** (opony). **Etap 3** (test bilansu sił) nie zmienia fizyki i może iść równolegle.

**Stan realizacji (20.11.2026):** etapy 0, 1, 2, 3 i 4.1 są zrobione (bez commita). Pomiary: `raport/2026-11-20/POMIARY.md`, opis: `PHYSICS.md`, „Poprawki z audytu fizyki z 20.11.2026”. Kryteria ukończenia etapów 1–3 są spełnione. Jedno odstępstwo dotyczy etapu 2: w „Silnym wietrze” udział hamowań awaryjnych strażnika w krokach wzrósł (1,07% → 1,71%), choć na okrążenie spadł, a wypadków jest ponad 10 razy mniej. Z planu zmieniono dwie rzeczy: asercję „kąty znoszenia < 1° poniżej 10 m/s” zastąpiła „brak poślizgu i kąty poniżej szczytu siły (3°) przy < 0,6 dostępnej przyczepności”, bo model dynamiczny przy 10 m/s i 1,2 g potrzebuje ok. 2° z samej sztywności opony; wspólna funkcja docisku ograniczyła się do `Car.downforceDamage`, bo przeniesienie całego iloczynu zmieniłoby kolejność mnożeń w fizyce i skróty stanu. Runda 2 (ten sam dzień): aquaplaning w planie dzielony na progu strefy; pełne `test:tracks` (38 torów bez problemów); etap 4.2 (`scripts/diag-tyres.mjs`) i 4.3 (dane referencyjne ze źródłami w `PHYSICS.md`) zrobione. Pomiar opon ujawnił błąd eksperta: hamowanie równomierne zamiast po krzywej planu wyrzucało go w deszczu z zakrętu 3 Albert Park; poprawione, z testem regresji. Etap 4.4 (kalibracja) nie wszedł: wariant mokrych opon zgodny z danymi Pirelli zwiększał wypadki stawki w deszczu do 20 razy, a kolejność mieszanek na suchym wymaga zmiany modelu ciepła i okien. Szczegóły: `raport/2026-11-20/POMIARY.md`.

---

## 1. Ocena punktów audytu

| # | Teza audytu | Werdykt po weryfikacji | Ważność wg audytu | Ważność po weryfikacji |
| --- | --- | --- | --- | --- |
| 1 | Planista nie odtwarza modelu aerodynamiki | Częściowo trafne. Część wymienionych czynników jest pomijalna albo już uwzględniona, a największa rozbieżność (wiatr wzdłuż toru) nie została nazwana | wysoka | średnia (wysoka przy silnym wietrze i wysokiej presji) |
| 2 | Przejście kinematyka → dynamika wymaga walidacji | **Potwierdzone sondą**: skok flag poślizgu, siły bocznej „w użyciu” i grzania opon przy 8 m/s | średnia, hipoteza | **wysoka** |
| 3 | Nie wiadomo, czy siły osi mieszczą się w kole tarcia | Konstrukcja kodu gwarantuje limit na każdej osi; brakuje tylko testu regresji | średnia | niska (zabezpieczenie) |
| 4 | Parametry opon nie są skalibrowane do danych | Trafne jako ograniczenie modelu | średnia | średnia, długoterminowa |

### 1.1 Punkt 1: planista i aerodynamika

Planista liczy docisk w `DrivePlanner.ts:84` (oraz 258 i 311) z prędkości auta względem toru, ze stałym zapasem `PLAN_AERO_SHARE` = 0,90. Fizyka liczy go w `Car.ts:1602-1632` z prędkości względem powietrza. Ocena czynników z audytu:

| Czynnik | Czy planista go zna | Wpływ | Ocena |
| --- | --- | --- | --- |
| Ślad aero (wake) | **Tak**, `car.wakeDownforce` w `DrivePlanner.ts:84` | — | Audyt jest tu sprzeczny sam ze sobą (najpierw „nie uwzględnia”, potem „uwzględnia część”) |
| Uszkodzenia | **Tak**, `(1 - 0.35 * car.damage)` | — | j.w. |
| Aktywna aero (X-Mode) | Nie, ale planista zakłada skrzydła zamknięte, a te zamykają się przy hamowaniu w 0,06 s (`ACTIVE_AERO_CLOSE`) | Ok. 0,03 s pełnej straty 50% docisku, czyli 2–3 m drogi przy 300 km/h | Pomijalne |
| Podłoga, prześwit, stall | Nie | `rideHeightLift` jest znormalizowane do 1 przy typowym prześwicie; zapas 0,9 to pokrywa | Niskie |
| Wiatr boczny | Nie | `0,6·sin²(β)`: przy 8 m/s bocznego wiatru i 40 m/s ok. 2% docisku | Niskie |
| **Wiatr czołowy / w plecy** | **Nie** (audyt go nie wymienia) | Patrz niżej: przy 11 m/s od −16% do +21% nacisku na opony w średnim zakręcie względem jazdy bez wiatru | **Istotne** |
| **Aquaplaning** | **Nie** (audyt go nie wymienia) | Do `AQUAPLANE_MAX_LOSS` na slickach powyżej 200 km/h na wodzie, `Car.ts:1665-1666` | Średnie, w oknie „zaczęło padać, auto jeszcze na slickach” |
| Czynniki okrążenia stresowego (`lapGripFactor` itd.) | Nie | — | **Celowo**: README mówi „Planista o tym nie wie”. Tego nie zmieniamy |

**Ile kosztuje wiatr wzdłuż toru.** Scenariusz „Silny wiatr” ma średnio 11 m/s z porywami (σ = 0,35), a „Burza” 13 m/s (`Weather.ts:56,59`). Weźmy zakręt przejeżdżany z prędkością 40 m/s (144 km/h), `Cl·A` = 4,30 m², masę ok. 850 kg:

- docisk bez wiatru: ok. 0,51 g, czyli nacisk 1,51 g; planista zakłada 1 + 0,9·0,51 = 1,46 g;
- wiatr w plecy 11 m/s: prędkość powietrza 29 m/s, docisk 0,27 g, nacisk **1,27 g (−13% względem planu)**;
- wiatr czołowy 11 m/s: nacisk 1,82 g (+25% względem planu, auto jedzie zbyt ostrożnie).

Przy presji 0 budżet zakrętu (0,7) mieści się w tej stracie. Przy maksymalnym marginesie `PaceSearch` (1,15) i „live push” (+12%) planista bierze jednak 0,7·1,15·1,12 ≈ 0,90 przyczepności, czyli ok. 1,32 g przy dostępnych 1,27 g. Przy presji +10 to ok. 1,08 przyczepności. Do tego `PaceSearch` uczy się marginesu osobno dla każdego zakrętu, a kierunek wiatru wolno się obraca, więc wyuczony margines się dezaktualizuje i to w różną stronę w różnych zakrętach.

**Wniosek:** propozycję audytu („wspólna funkcja docisku dla planisty i fizyki”) warto przyjąć w ograniczonej formie: wspólna czysta funkcja współczynnika docisku plus wiatr wzdłuż linii i aquaplaning w planiście. Planista nie powinien natomiast odtwarzać pełnego kroku fizyki (stall podłogi, morświnowanie, czynniki okrążenia stresowego): nie zna przyszłego stanu i ma celowo nie znać warunków okrążenia stresowego.

### 1.2 Punkt 2: przejście kinematyka → dynamika (potwierdzone)

**Sonda.** Bolid na prostym torze testowym utrzymywał stałą prędkość przez 60 kroków (1 s, 60 Hz) ze stałym skrętem. Prędkość była przywracana przed każdym krokiem (`updatePhysics`, opony 95 °C). Moduł `Car.ts` zbudowano Vite tak samo jak w `scripts/audit-physics.mjs`. Wybrane wiersze:

| Skręt | v (m/s) | Przyspieszenie boczne (g) | `frontLateralInUse` (kN) | Kroki z `isSliding` / 60 | Zmiana temp. bieżnika przodu (°C/s) |
| --- | --- | --- | --- | --- | --- |
| 0,5 | 7,98 | 0,36 | 1,54 | 0 | −1,9 |
| 0,5 | 8,02 | 0,37 | 1,56 | 0 | −1,9 |
| 0,5 | **8,10** | 0,37 | **7,42** | **52** | **+0,8** |
| 0,5 | 10 | 0,56 | 6,86 | 0 (poślizg „skid” 56) | +0,4 |
| 1,0 | 8,02 | 0,76 | 3,25 | 0 | −1,9 |
| 1,0 | **8,10** | 0,78 | **7,95** | **56** | **+3,8** |
| 1,0 | 12 | 1,64 | 8,24 | 57 | +6,7 |

Przy 8,02 → 8,10 m/s ruch auta prawie się nie zmienia (przyspieszenie boczne 0,37 g), ale siła boczna „w użyciu” rośnie 4,8 razy, flaga poślizgu przeskakuje z 0 na 52/60, a opony zamiast stygnąć zaczynają się grzać.

**Przyczyna 1: niespójny punkt odniesienia modelu kinematycznego.** Model kinematyczny tłumi prędkość boczną w środku ciężkości do zera (`slideForce`, `Car.ts:1791`). W kinematyce jednośladu środek ciężkości ma jednak dryf `vy = lr·r` (kąt `β = atan(lr/L·tanδ)`): to oś tylna nie ma poślizgu bocznego. Gdy model kąta znoszenia dostaje stan z `vy ≈ 0`, widzi na obu osiach kąt ok. `0,46·δ` (`Car.ts:1814-1815`). Przy δ = 0,2 rad to ok. 5,3°, czyli za szczytem siły (ok. 3°). Model dynamiczny „widzi” obie osie nasycone, choć auto skręca przy 0,37 g.

**Przyczyna 2: wielkości pomocnicze nie są mieszane wagą `dynamicWeight`.** Siła boczna i odchylenie są mieszane (`Car.ts:1856-1857`), ale:

- `frontSlip`, `rearSlip`, `slipRatio` (`Car.ts:1858-1862`) pochodzą w całości z modelu dynamicznego już przy wadze 0,01;
- `frontLateralInUse` / `rearLateralInUse` (`Car.ts:1866`) to pełne siły dynamiczne, a nie wynik mieszania;
- moc poślizgu do grzania opon (`Car.ts:1842-1843`) nie jest mnożona przez `dynamicWeight`;
- kąty znoszenia są zerowane poniżej 8 m/s (`Car.ts:1863`).

**Gdzie to szkodzi.** Zakres 8–16 m/s (29–58 km/h) obejmuje start wyścigu, wyjazd z alei, odzyskiwanie kontroli i najwolniejsze zakręty. Według `PHYSICS.md` mediana minimalnej prędkości eksperta na prawdziwych torach to 57 km/h (15,8 m/s), a w Monako 26 km/h. Fałszywe flagi trafiają do:

- `DrivePlanner.ts:319-321`: ekspert ogranicza gaz do 0,2 przy `isSliding`, więc wyjście z nawrotu jest przytłumione, a sieć uczy się tego od nauczyciela;
- `Car.ts:1439`: sieć ma limit gazu 0,55 przy `isSliding`;
- `DrivePlanner.ts:99`: brak „live push” w wolnych zakrętach;
- `DrivePlanner.ts:358` → `PaceSearch`: fałszywy poślizg w wolnych zakrętach zawyża ich „typowy poślizg” i zaburza szukanie marginesu;
- `Fitness.ts:81,97`: kara fitness za poślizg i brak premii za czystą bramkę;
- `Population.ts:625`: auto „w poślizgu” nie może zacząć ataku;
- `Car.ts:1684-1689, 1738-1739`: zawyżona siła „w użyciu” zmniejsza budżet hamowania i ułatwia blokowanie kół przy dohamowaniu do nawrotu;
- `Effects.ts:166-168`: ślady i dym w wolnych zakrętach.

### 1.3 Punkt 3: koło tarcia osi

Z przepływu kodu wynika, że każda oś mieści się w swoim limicie:

- przód: `|frontFx| ≤ frontBrakeLimit ≤ frontLimit` (`Car.ts:1688, 1734, 1740, 1765`); `frontLateral = √(frontLimit² − frontFx²)` (`:1771`); `|frontForce| ≤ 0,89·frontLateral` (`:1821`); obrót o kąt skrętu (`:1826`) nie zmienia normy wektora;
- tył: `rearFx` jest obcięte do `±rearLimit` (`:1766`), `rearLateral = √(rearLimit² − rearFx²)` (`:1772`), `|rearForce| ≤ rearLateral` (`:1822`);
- model kinematyczny ogranicza sumę sił bocznych do `frontLateral + rearLateral` (`:1793`); mieszanka dwóch ograniczonych wartości też jest ograniczona;
- dyferencjał i różnica nawierzchni pod kołami (`:1832-1840`) to momenty, nie dodatkowe siły wypadkowe.

Drobna uwaga: `sideSplit` dzieli siłę wzdłużną między koła według μ, ale bez transferu obciążenia z przechyłu, więc pojedyncze koło przy dużym przechyle może dostać nieco więcej, niż przeniesie. To szczegół modelu, nie błąd bilansu osi. Test własnościowy proponowany przez audyt jest tani i przyda się jako zabezpieczenie przed przyszłymi zmianami, ale nie ma czego naprawiać.

### 1.4 Punkt 4: opony

Ograniczenie jest opisane trafnie. Repozytorium nie zawiera danych referencyjnych, więc „kalibracja do danych” wymaga najpierw ich zebrania. Dziś można zrobić dwie rzeczy: zmierzyć obecne zachowanie (długość stintów, degradację, temperatury) i zabezpieczyć testami jakościowe niezmienniki (kolejność mieszanek, punkty przejścia slick → inter → wet). Z `Tyres.ts` wynika dziś przejście slick (medium) → inter przy wilgotności ok. 0,23–0,25 i inter → wet przy ok. 0,69–0,72 (równa przyczepność / próg `weatherCompound` z zapasem 0,01).

---

## 2. Plan działania

Zasady obowiązujące w każdym etapie (z `AGENTS.md`):

- przed każdym commitem: `npx tsc --noEmit`, `npm run lint`, `npm test` (ok. 1,5 min);
- `npm run bench:step -- 60` przed zmianą i po niej: refaktor zachowuje skróty stanu, zmiana fizyki je zmienia (zapisać nowe);
- nowy stan całkuje się tak samo przy 30, 60 i 120 Hz;
- bez przełączników mechaniki i bez zależności fizyki od `isRaceMode`;
- losowość tylko z `random()`;
- zmiana czasów okrążeń → datowana notatka w `PHYSICS.md` i akapit zgodności w `README.md`;
- jeden etap = jeden commit (lub kilka), osobno mierzony.

### Etap 0: punkt odniesienia (rozmiar S)

Cel: liczby „przed”, z którymi porównamy każdy etap.

1. `npm run bench:step -- 60`: zapisać µs na krok i skróty stanu.
2. `node scripts/bench-laptime.mjs 1800 145,456,789` (ok. 15 min): najlepszy czas, mediana rekordów, `lateMedian`, czas poza asfaltem.
3. `npm run diag:nn -- 600` oraz `-- --expert` (ziarna 1–3): okrążenia, DNF, interwencje strażnika według przyczyny.
4. Nowy skrypt `scripts/diag-lowspeed.mjs`: udział kroków z `isSliding` / `isSkidding` i blokadą kół w pasmach prędkości (0–8, 8–12, 12–16, 16–25, >25 m/s) dla eksperta na GP, Monako, Monzie i Hungaroringu. Ten pomiar pokaże, jak często błąd z punktu 2 występuje w prawdziwej jeździe, a nie tylko w sondzie.
5. Wyniki zapisać w `raport/2026-11-20/baseline.md` (wzorem `raport/2026-10-25/`).

### Etap 1: spójne przejście kinematyka → dynamika (rozmiar M, priorytet 1)

Pliki: `src/physics/Car.ts` (ok. 1783-1886), testy w `scripts/audit-physics.mjs` lub `scripts/test-units.mjs`.

1. **Najpierw test (czerwony).** Przemiatanie stanu ustalonego jak w sondzie z punktu 1.2, v = 6…20 m/s, skręt 0,5 i 1,0, przy 30, 60 i 120 Hz. Asercje:
   - brak `isSliding`, gdy przyspieszenie boczne < 0,6 dostępnej przyczepności;
   - ciągłość: między 7,9 a 8,2 m/s `frontLateralInUse`, `slipRatio` i przyrost temperatury bieżnika zmieniają się najwyżej o 15%;
   - w stanie ustalonym poniżej 10 m/s kąty znoszenia obu osi < 1°;
   - wyniki 30/60/120 Hz zgodne w tolerancji używanej już w `test-runoff`.
2. **Poprawka przyczyny 1: odniesienie kinematyki do osi tylnej.** W `slideForce` (`:1791`) tłumić różnicę `lateralSpeed − toRear·yaw` zamiast samej `lateralSpeed`, czyli dążyć do dryfu `vy = lr·r` z kinematyki jednośladu. Przy wadze dynamicznej → 0 kąty znoszenia obu osi dążą wtedy do 0 i oba modele zgadzają się na granicy. `toRear` trzeba wyliczyć przed blokiem dynamicznym (dziś jest lokalny w `:1809`).
3. **Poprawka przyczyny 2: mieszanie wielkości pomocniczych.**
   - `frontSlip`, `rearSlip`, `slipRatio` = mieszanka kinematycznej i dynamicznej wartości z wagą `dynamicWeight`;
   - `frontLateralInUse` / `rearLateralInUse` = mieszanka podziału kinematycznego (`:1867`) i sił dynamicznych (`:1866`);
   - `frontSlipPower` / `rearSlipPower` (część boczna) × `dynamicWeight`;
   - kąty znoszenia poniżej `DYNAMIC_FROM`: zamiast zerowania relaksować do wartości kinematycznych (po kroku 2 to ok. 0). To usuwa skok przy ponownym wejściu w zakres dynamiczny.
4. **Weryfikacja.** Test z kroku 1 zielony; `npm test` (szczególnie `test-runoff`, `test-suspension`, `test-neural-driving`, `test-parity`); `diag-lowspeed` porównany z etapem 0; `npm run test:tracks` (Monako ma nawrót poniżej 8 m/s).
5. **Czego się spodziewać:** mniej fałszywych poślizgów i blokad w nawrotach, pełniejszy gaz na wyjściu z wolnych zakrętów (ekspert i sieć), inne temperatury opon na torach z wolnymi zakrętami, prawdopodobnie szybsze okrążenia na Monako, Hungaroringu i w Singapurze. Zmienią się skróty `bench:step`.
6. **Dokumentacja:** w `PHYSICS.md`, sekcja „Dynamika poślizgu”, zdanie „odpowiedź płynnie przechodzi w kinematyczną” jest dziś nieprawdziwe dla flag i grzania. Dopisać datowaną notatkę z pomiarem przed i po oraz wpis w akapicie zgodności `README.md`. Zapisane modele wczytują się bez zmian (wejścia sieci się nie zmieniają), ale warto je douczyć.

Kryterium ukończenia: test ciągłości zielony przy 30/60/120 Hz, `npm test` zielony, w `diag-lowspeed` udział `isSliding` w paśmie 8–16 m/s spada do poziomu pasma 16–25 m/s lub niżej, liczba DNF nie rośnie.

Ryzyko: odniesienie do osi tylnej zmienia trajektorię środka ciężkości w bardzo wolnych zakrętach (auto „wychodzi” odrobinę szerzej). Jeśli `test-runoff` albo Monako pokażą więcej wyjazdów, zostaje sama poprawka z kroku 3, a krok 2 trafia do osobnej próby.

### Etap 2: planista — wiatr wzdłuż linii i aquaplaning (rozmiar M, priorytet 2)

Pliki: `src/physics/DrivePlanner.ts`, `src/physics/Car.ts` (funkcja pomocnicza), testy w `scripts/test-units.mjs` / `scripts/test-weather.mjs`.

1. **Wspólna funkcja współczynnika docisku (refaktor bez zmiany wyniku).** Czysta statyczna funkcja w `Car` (np. `Car.downforcePerV2(airDensity, coeff, wake, damage)`) używana w `DrivePlanner.ts:84, 258, 311` i w `Car.ts:1617` dla części wspólnej. Po tym kroku skróty `bench:step` muszą zostać takie same (zachować kolejność mnożeń, żeby nie zmienić zaokrągleń). Do funkcji **nie** dodawać `lapGripFactor`, stallu podłogi ani aktywnej aero: planista celowo ich nie zna albo nie da się ich przewidzieć.
2. **Wiatr wzdłuż linii.** Dla każdej próbki linii `h = −(windMean · t̂)`, gdzie `t̂` to styczna linii w punkcie próbki. Planista bierze **średni** wiatr scenariusza (`windSpeed`, `windDir` z `Weather.ts`), a nie chwilowy poryw (`windX`/`windY` zawierają `gust`): kierowca zna kierunek wiatru, porywów nie przewiduje. Prędkość graniczna zakrętu z `v²κ = μ(g + a(v + h)²)` daje równanie kwadratowe:
   `(κ − μa)·v² − 2μah·v − μ(g + ah²) = 0`, `v = [μah + √(μ²a²h² + (κ − μa)·μ·(g + ah²))] / (κ − μa)` dla `κ > μa`.
   Przy `h = 0` należy zostawić dzisiejszy wzór (osobna gałąź), żeby w bezwietrznym „słonecznie” wynik był identyczny co do bitu. W hamowaniu (`brakeFor`, `entrySpeedSq`) zachować rozwiązanie w postaci zamkniętej i przybliżyć wpływ wiatru współczynnikiem `((v_ref + h)/v_ref)²` dla docisku i oporu, liczonym przy `v_ref` = średnia z prędkości bieżącej i bezpiecznej, obciętym do [0,5; 1,5]. To przybliżenie trzeba opisać w komentarzu.
3. **Aquaplaning.** W `brakeFor` i przy przeliczaniu pedału (`DrivePlanner.ts:258`) pomnożyć `tyreMu` przez `1 − Car.aquaplaneLoss(car.tyreCompound, car.wetness, v)` przy prędkości bieżącej; w zakręcie przy `safeV`.
4. **Testy.**
   - jednostkowy: przy wietrze w plecy prędkość bezpieczna zakrętu jest niższa, przy czołowym wyższa, a przy `h = 0` identyczna z dzisiejszą;
   - jednostkowy: na mokrym torze na slickach powyżej 200 km/h droga hamowania planisty się wydłuża, a na interach się nie zmienia;
   - `bench:step` dla ziaren bez wiatru: skróty bez zmian (jeśli bench działa w „słonecznie”; sprawdzić to przed zmianą).
5. **Pomiar.** Ekspert solo (`diag:nn -- --expert`, ziarna 1–3) w scenariuszach „Słonecznie”, „Silny wiatr”, „Burza”, „Przelotny deszcz” przed i po: hamowania awaryjne strażnika (`causes.brake`), wyjazdy, czasy. Oczekiwanie: w „Słonecznie” bez zmian; w wietrze mniej hamowań awaryjnych i wyjazdów w zakrętach z wiatrem w plecy; w deszczu mniej blokad przy hamowaniu z dużej prędkości na slickach.
6. **Dokumentacja:** notatka w `PHYSICS.md` (sekcje „AI, paliwo i postój” i „Pogoda”), wpis w akapicie zgodności `README.md`. Wejścia sieci się nie zmieniają, więc modele się wczytują, ale nauczyciel jest inny i warto je douczyć.

Kryterium ukończenia: testy zielone, „Słonecznie” bez zmian w skrótach, w „Silnym wietrze” hamowania awaryjne na okrążenie spadają, a liczba wyjazdów nie rośnie w żadnym scenariuszu.

### Etap 3: test bilansu sił osi (rozmiar S, równolegle z etapem 1)

Pliki: `src/physics/Car.ts` (tylko zapis diagnostyczny), `scripts/test-units.mjs`.

1. Zapisywać w kroku fizyki ostatnie siły osi w obiekcie diagnostycznym tylko do odczytu (np. `lastAxleForces = { frontFx, frontFy, rearFx, rearFy, frontLimit, rearLimit }`), bez wpływu na fizykę. Skróty `bench:step` bez zmian (sprawdzić, czy skrót nie obejmuje nowych pól).
2. Test własnościowy: 2000 losowych stanów z ziarnem (`seedRandom`): prędkość 0–90 m/s, skręt −1…1, gaz albo hamulec, prędkość boczna, odchylenie, wilgotność, mieszane nawierzchnie pod kołami, temperatury opon, uszkodzenia. Asercje na każdą oś:
   - przód: `√(Fx² + (Fy/FRONT_GRIP_BIAS)²) ≤ frontLimit·(1 + 1e-9)`;
   - tył: `√(Fx² + Fy²) ≤ rearLimit·(1 + 1e-9)`;
   - przy zablokowanym kole `|Fy| ≤ LOCKED_LATERAL · limit`.
3. Jeśli test przejdzie (oczekiwane, patrz punkt 1.3), zostaje jako zabezpieczenie. Jeśli nie, centralne obcięcie wektora siły osi przed całkowaniem i analiza przypadku.

### Etap 4: opony — pomiar, niezmienniki, potem kalibracja (rozmiar L, priorytet 3)

1. **Niezmienniki (od razu, rozmiar S).** Testy w `scripts/test-units.mjs`:
   - na suchym: soft > medium > hard w tempie pierwszych okrążeń, odwrotna kolejność w zużyciu;
   - przejście slick → inter przy wilgotności 0,15–0,35, inter → wet przy 0,6–0,8 (dziś ok. 0,25 i 0,72);
   - opona poza oknem traci przyczepność symetrycznie względem `optimum` zgodnie z `coldWidth`/`hotWidth`.
   Testy nie zmieniają fizyki; pilnują, żeby przyszła kalibracja nie odwróciła kolejności.
2. **Pomiar (`scripts/diag-tyres.mjs`, rozmiar M).** Deterministyczne scenariusze, ekspert solo, ziarna 1–3:
   - stint na GP, Albert Park i Monzy dla każdej mieszanki: czas okrążenia, zużycie na okrążenie, liczba okrążeń do 70% (próg postoju AI), temperatury bieżnika i karkasu;
   - skidpad przy 3 prędkościach: temperatury ustalone;
   - przemiatanie wilgotności 0…1: czas okrążenia na S/M/I/W.
3. **Cele referencyjne (rozmiar M, praca źródłowa).** Zebrać publiczne dane (materiały Pirelli o oknach temperatur, typowe długości stintów i degradacja w s/okr. z wyścigów) i zapisać tabelę celów ze źródłami w `PHYSICS.md`. To jest cel „wiarygodnego zakresu” dla gry, nie kalibracja do telemetrii zespołu.
4. **Kalibracja.** Zmieniać jeden parametr naraz (`wear`, `optimum`, `coldWidth`/`hotWidth`, `grip` w `Tyres.ts`, stałe ciepła w `Car.ts`), za każdym razem z pomiarem z kroku 2 i notatką w `PHYSICS.md`. Kalibracja nie powinna ruszać przed etapem 1, bo etap 1 zmienia grzanie opon w wolnych zakrętach.

### Etap 5: domknięcie

- Po każdym etapie: notatka w `PHYSICS.md` z datą i pomiarem przed i po, wpis w akapicie zgodności `README.md`, nowe skróty `bench:step`.
- Po etapach 1 i 2: ponowne `bench-laptime 1800` na trzech ziarnach i `test:tracks` (ok. 20 min).
- Uzupełnić `AUDYT_FIZYKI_2026-11-20.md` krótką notą „stan po weryfikacji” z odnośnikiem do tego planu albo przenieść oba pliki do `raport/2026-11-20/`.

---

## 3. Kolejność i zależności

| Etap | Zmienia fizykę / czasy | Zależy od | Rozmiar | Priorytet |
| --- | --- | --- | --- | --- |
| 0. Punkt odniesienia | nie | — | S | przed wszystkim |
| 1. Przejście kinematyka → dynamika | tak | 0 | M | 1 |
| 3. Test bilansu sił | nie | — | S | równolegle z 1 |
| 2. Wiatr i aquaplaning w planiście | tak (planista) | 1 (nowe marginesy `PaceSearch` po etapie 1) | M | 2 |
| 4.1 Niezmienniki opon | nie | — | S | dowolnie |
| 4.2–4.4 Pomiar i kalibracja opon | tak | 1, 2 | L | 3 |

Etap 1 idzie pierwszy, bo zmienia dane wejściowe dla pozostałych: grzanie opon, budżet hamowania i flagi poślizgu, z których korzystają planista, `PaceSearch` i fitness. Kalibrowanie opon albo planisty przed jego naprawą oznaczałoby dostrajanie do błędu.

## 4. Czego nie robić

- Nie dawać planiście pełnego modelu kroku fizyki ani wiedzy o okrążeniu stresowym: zapas planisty i jego niewiedza o `lapGripFactor` są celowe (README, „Trudne okrążenia”).
- Nie usuwać `PLAN_AERO_SHARE` przy okazji etapu 2: po dodaniu wiatru zostaje zapasem na stall podłogi, balans i porywy.
- Nie zmieniać współczynników opon „na oko” przed etapem 4.2.
- Nie dodawać przełączników typu „stary model przejścia”: `AGENTS.md` zabrania przełączników mechaniki.
