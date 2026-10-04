# Audyt fizyki — 04.10.2026

> Raport stanu sprzed napraw. Potwierdzone problemy 1–8 zostały poprawione; aktualny model i ograniczenia opisuje `PHYSICS.md`. Liczby poniżej zachowano jako dowody historyczne.

Badana rewizja: `979d941b0fe9302512a5a4b0928df96551a1c953`; uwzględniono bieżący katalog roboczy. Audyt nie zmienia kodu aplikacji. Dodano skrypt reprodukcji `scripts/audit-physics.mjs`.

## Ocena

Model jest hybrydowym modelem kinematycznym do gry, z elementami dynamiki wzdłużnej i ograniczaniem skrętu na podstawie przyczepności. Nie jest pełnym dynamicznym modelem pojazdu 2D. Występują potwierdzone niespójności sił, telemetrii i skali. Deklaracje dokumentacji o realistycznych poślizgach, hamowaniu i stabilności nie są dostatecznie uzasadnione implementacją.

P1: błąd podstawowych równań lub limitów, istotnie zmieniający jazdę. P2: błąd funkcjonalny, telemetrii lub skali. Uproszczenia opisano osobno; nie wszystkie muszą zostać usunięte, jeżeli celem jest gra zręcznościowa.

## Potwierdzone problemy

### 1. P1 — Hamulce przekraczają limit tarcia przyjęty dla opon

`src/physics/Car.ts:578–637`.

Maksymalne siły hamowania wynoszą `1.60 * mu * Fz` na każdej osi. Ten mnożnik nie oznacza większej wydajności materiału hamulców: kontakt opony z podłożem nadal musi ograniczać przenoszoną siłę. Jednocześnie koło tarcia używa `mu * Fz`, obcina wykorzystanie do 0,98 i zachowuje co najmniej około 22,4% przyczepności bocznej. Pozwala to hamować powyżej własnego limitu tarcia i nadal skręcać.

Reprodukcja: pierwszy krok pełnego hamowania ze 100 km/h daje **3,43 G**, a z 400 km/h **10,29 G**. Po odjęciu oporu aero i toczenia siła hamowania opon wynosi **1,60 × mu × Fz**. To sprzeczność wewnątrz modelu, niezależna od porównania z rzeczywistym F1. Hamowanie nie uwzględnia również `lapGripFactor`, mimo że napęd i siła boczna go uwzględniają. Komentarz o biasie 56/44 nie odpowiada równaniom: siły rozdzielane są według obciążeń osi.

Zalecenie: osobny limit momentu hamulców oraz wspólny limit sił opony, identyczny dla hamowania, napędzania i skręcania, z rzeczywistym rozdziałem między osie. Nie obcinać przekroczenia wyłącznie we wzorze na siłę boczną.

### 2. P1 — Obracanie wektora prędkości i tłumienie poślizgu przekraczają budżet siły bocznej

`src/physics/Car.ts:681–707`.

Prędkość globalna jest rekonstruowana w obróconym układzie pojazdu, co samo zmienia jej kierunek. Dodatkowo kod tłumi składową boczną. Budżet tych dwóch efektów rozlicza przez pierwiastek z różnicy kwadratów i `hypot`, jakby siły były prostopadłe. Oba efekty wpływają na tę samą składową boczną: zależnie od znaku poślizgu dodają się lub odejmują. Rekonstrukcja obraca także istniejącą składową boczną, wpływając na przyspieszenie wzdłużne bez odzwierciedlenia w jego telemetrii.

Reprodukcja: `vx=30 m/s`, `vy=-2 m/s`, `steer=0.1`, krok 1/60 s. Budżet przyczepności wynosi **2,156 G**, lecz zmiana globalnej prędkości w osi bocznej początkowego układu daje **2,920 G**. HUD wskazuje **2,156 G**. Dla `vy=+2 m/s` zmiana ma przeciwny znak (**−0,881 G**), a HUD ponownie wskazuje dodatnie **2,156 G**.

Zalecenie: integrować globalny wektor prędkości z jednej wynikowej siły. Jeśli używany jest układ pojazdu, uwzględnić człony wynikające z jego rotacji. Siły w tej samej osi sumować algebraicznie przed ograniczeniem.

### 3. P2 — Limit przyczepności skrętu nie działa poniżej 10 m/s

`src/physics/Car.ts:614–652`.

Ograniczenie yaw rate uruchamia się tylko przy `abs(newForwardSpeed) > 10`. Poniżej tego progu pojazd realizuje pełny skręt kinematyczny nawet przy zerowej dostępnej sile bocznej. Próg tworzy nieciągłość zachowania.

Reprodukcja graniczna: po ustawieniu `baseTireGrip=0`, przy 9,9 m/s pełny skręt daje **1,162 rad/s** i zmianę kierunku mimo telemetrii **0 G**. Przy 10,1 m/s yaw rate wynosi **0**. Zerowa przyczepność jest kontrolowanym testem granicznym, nie domyślnym ustawieniem aplikacji.

Zalecenie: limitować siłę przy każdej prędkości; model małych prędkości przełączać płynnie, z zabezpieczeniem dzielenia przez zero.

### 4. P2 — Opór aerodynamiczny ma niewłaściwy kierunek przy jeździe bokiem

`src/physics/Car.ts:541–553`.

Wartość oporu zależy od całej prędkości, lecz siła działa wyłącznie w osi nadwozia, ze znakiem zależnym od prędkości wzdłużnej. Przy ruchu wyłącznie bocznym generuje prędkość wzdłużną zamiast przeciwdziałać ruchowi bocznemu.

Reprodukcja izolująca aerodynamikę: `vx=0`, `vy=50 m/s`, przyczepność ustawiona na zero, bez gazu i skrętu. Po jednym kroku `vx=−0,016923 m/s`, `vy=50 m/s`; moduł prędkości **rośnie** do 50,000002864 m/s. Wzrost jest niewielki, lecz pokazuje błędny kierunek i bilans energii. Test nie modeluje typowej jazdy po asfalcie.

Zalecenie: opór skierowany przeciwnie do prędkości względem powietrza, ewentualnie model z odrębnymi współczynnikami oporu wzdłużnego i bocznego.

### 5. P2 — Telemetria nie przedstawia faktycznego przyspieszenia

`src/physics/Car.ts:602–605`, `:701–704`, `:618–622`.

Przyspieszenie wzdłużne jest obcinane do zakresu −8…4 G bez ograniczania rzeczywistego ruchu. Przy hamowaniu z 400 km/h rzeczywiste opóźnienie wynosi 10,29 G, a telemetria −8 G. Dodatkowo ta obcięta wartość steruje transferem mas w następnym kroku.

Przyspieszenie boczne jest zawsze nieujemne. Symetryczne skręty w lewo i w prawo przy 30 m/s dają przeciwne yaw rate, lecz identyczne **+1,019 G**. `rollAngle` korzysta z tej wartości, więc po rozwinięciu zakrętu przechył ma ten sam znak dla obu kierunków. Problem zgodności telemetrii z ruchem pokazuje też punkt 2.

Zalecenie: liczyć podpisane przyspieszenie ze zmiany globalnej prędkości i rzutować je na ustalony układ pojazdu. Ograniczenia wizualnego wskaźnika oddzielić od wartości fizycznych używanych do transferu mas.

### 6. P2 — Szerokość toru i rozmiar auta nie mają spójnej skali fizycznej

`src/physics/Car.ts:40–74`, `:709–716`; `src/main.ts:63–68`.

Fizyka i geometria trasy przyjmują 1 px = 1 m. Suwak opisany jako szerokość w metrach mnoży tę wartość przez 5,4. Ustawienie **14 m** generuje szerokość **76 jednostek**, czyli 76 m w pozostałych równaniach. Długość 30 px i szerokość 14 px auta są opisane jako wizualne i nie uczestniczą w modelu kontaktu; nie należy traktować ich jako fizycznych wymiarów bolidu.

Wpływ: inne od deklarowanych przestrzenie do jazdy, odległości od ścian i progi checkpointów. Rozmiary grafiki mogą być celowo powiększone, ale szerokość fizycznej drogi nie powinna zmieniać jednostek.

Zalecenie: geometria świata w metrach, skala renderowania jako osobna transformacja kamery. Jawnie oddzielić fizyczny obrys auta od powiększonego symbolu graficznego.

### 7. P2 — Pusty bak nadal zapewnia moc i wysoką prędkość

`src/physics/Car.ts:518–522`, `:568–575`, `:825–835`.

Przy zerowym paliwie gaz jest ograniczony do 8%, lecz silnik nadal dysponuje do **60 kW**, bez zużycia paliwa. Komentarz deklaruje około 18 km/h. W teście na wirtualnym nieograniczonym torze po 300 s przy pełnym żądaniu gazu samochód z pustym bakiem jedzie **179,24 km/h** i pozostaje aktywny. Wykluczenie za brak paliwa wymaga prędkości poniżej 1 m/s, więc rozpędzony samochód nie spełnia tego warunku.

Zalecenie: przy pustym baku odciąć napęd lub jawnie modelować ograniczony energetycznie napęd awaryjny. Jeżeli jest to pomoc zręcznościowa, nazwać ją tak i zdefiniować docelową prędkość zamiast samego procentu gazu.

### 8. P2 — Postój w boksie zatrzymuje zegar okrążenia

`src/physics/Car.ts:479–507`, `:974–979`.

Gałąź postoju zwiększa `totalRaceTime`, lecz pomija `lapTime`. Samochód zatrzymuje się natychmiast po zdarzeniu okrążenia, bez przejazdu fizycznej alei serwisowej. Czas postoju nie wchodzi do pomiaru następnego okrążenia.

Reprodukcja: 193 kroki po 1/60 s z `isPitting=true`, `pitTimer=3.2`, 10 kg paliwa. `totalRaceTime=3,2167 s`, `lapTime=0`, paliwo **100,0667 kg**. Zakończenie jest kwantowane krokiem, więc tankowanie trwa nieco ponad 3,2 s. Nie jest to gwarantowane tankowanie do 105 kg opisane w dokumentacji.

Zalecenie: zegar okrążenia powinien obejmować postój; czas tankowania uzależnić od celu i przepływu, a ewentualny przejazd aleją i jej limit prędkości modelować osobno.

## Ograniczenia modelu i rozbieżności dokumentacji

- **Brak dynamicznej rotacji nadwozia.** `angularVelocity` jest przypisywane wprost z modelu rowerowego `v/L*tan(delta)` i limitu siły. Brakuje momentu bezwładności yaw, momentów sił osi, kątów poślizgu przedniej i tylnej osi oraz zależności siły opon od tych kątów. Przy zwolnieniu skrętu yaw rate w teście przechodzi z ±0,333 rad/s bezpośrednio do zera w jednym kroku. Podsterowność i nadsterowność są wskaźnikami przekroczenia limitu, a nie odrębnymi mechanizmami dynamiki osi. Jest to ważne ograniczenie dla celu „realistyczny symulator”.
- **Kontakt z torem jest punktowy.** `checkTrackProgress()` bada położenie środka, a `Track.isOutOfBounds()` używa odległości od osi trasy i progu `0.54*width`. Nie uwzględnia obrysu, narożników ani kierunkowego kontaktu z barierą. Przekroczenie granicy skutkuje zatrzymaniem i wykluczeniem; brak impulsu zderzenia. W pętli populacji brak modelu kontaktu bolid–bolid.
- **Stałe aero są uproszczeniem.** Wzory z kwadratem prędkości są poprawnym punktem wyjścia, lecz brak wpływu wysokości podwozia, kąta znoszenia, konfiguracji skrzydeł czy zmiany warunków. Nie zbadano zgodności współczynników z danymi rzeczywistego samochodu.
- **Specyfikacja jest rozbieżna z kodem.** `opis.md` podaje współczynnik docisku 3,20 i tarcia 1,70; kod ma 2,65 i 1,85. Pojemność w kodzie wynosi 110 kg, paliwo początkowe 105 kg. Przy 400 km/h obecny wzór daje około **20 039 N**, czyli równoważnik **2043 kg** nacisku, a nie deklarowane 2,4–2,5 t.
- **AI nie jest pomiarem możliwości fizyki.** Plan hamowania w `getAIControl()` korzysta z arbitralnego `12 * brakingAggression m/s²` i własnego przybliżenia docisku. Znacząco różni się od zdolności hamowania solvera. Osiągnięte tempo zależy więc również od reguł sterownika.
- **Czas symulacji a rzeczywisty.** Worker wykonuje stałe kroki 1/60 s w tickerze 16 ms, bez akumulatora czasu rzeczywistego. Przy idealnym wykonaniu jeden krok na tick daje nominalnie około 1,0417 s symulacji na sekundę; opóźnienia tickera zmieniają tę relację. W trybach przyspieszonych jest to dopuszczalne, lecz oznaczenie 1× nie gwarantuje czasu rzeczywistego.

## Elementy działające i zakres weryfikacji

- Hamowanie stojącego auta: **0 m/s i 0 m przemieszczenia po 120 krokach**. Historyczny błąd nadawania prędkości przez hamulec nie wystąpił w tym teście.
- Stały krok 1/60 s w workerze jest korzystny dla powtarzalnej integracji; zmiana mnożnika zwiększa liczbę kroków, a nie samo `dt`.
- Masa zawiera paliwo, napęd ma ograniczenie mocą i trakcją tylnej osi; docisk i opór mają postać proporcjonalną do v². Są to sensowne składniki bazowe wymagające spójnego połączenia.
- Hamowanie z 400 km/h do zatrzymania na izolowanej prostej: **2,433 s i 105,18 m**. Zgodność z deklarowaną krótką drogą nie potwierdza realizmu: test ujawnia jednocześnie przekroczenie limitu tarcia.

Reprodukcje: `node scripts/audit-physics.mjs`. Skrypt buduje rzeczywisty moduł `Car.ts` przez Vite do katalogu tymczasowego i usuwa go po wykonaniu. Losowe mnożniki osiągów ustawiane są na 1. Wirtualny tor bez granic i checkpointów izoluje równania od AI, kolizji i pomiaru okrążeń. Testy zerowej przyczepności świadomie zmieniają parametr w pamięci. Wyniki nie są benchmarkiem rzeczywistego bolidu F1 ani pełnym testem gry w przeglądarce.

## Kolejność prac

1. Uzgodnić cel: spójna fizyka zręcznościowa albo dynamiczny model rowerowy 3DOF.
2. Naprawić wspólny budżet sił opon i integrację wektora prędkości; z tego samego ruchu wyznaczać telemetrię.
3. Usunąć próg przyczepności 10 m/s i poprawić wektor oporu aerodynamicznego.
4. Ujednolicić metry świata, geometrię drogi i obrys pojazdu.
5. Poprawić brak paliwa, zegar postoju i model obsługi boksu.
6. Dopiero potem kalibrować osiągi, hamowanie i AI, oraz zaktualizować dokumentację.

## Źródła odniesienia

- [MathWorks: Vehicle Body 3DOF](https://www.mathworks.com/help/vdynblks/ref/vehiclebody3dof.html) — rozdzielenie ruchu wzdłużnego, bocznego i yaw, kątów poślizgu oraz sił osi. To odniesienie do brakujących składników dynamicznego modelu, nie wymóg używania tego produktu.
- [MathWorks: Modeling a Vehicle Dynamics System](https://www.mathworks.com/help/ident/examples/modeling-a-vehicle-dynamics-system.html) — równania ruchu modelu rowerowego.
- [NASA: Drag Equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/) i [Lift Equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/lift-equation/) — zależność oporu i siły aerodynamicznej od gęstości, powierzchni, współczynnika i kwadratu prędkości. Nie potwierdzają wartości współczynników wybranych w tym projekcie.
