# Odpowiedź na „Audyt Systemu Symulacji Wyścigowej Bolidów F1”

18.10.2026. Każdą uwagę porównano z kodem (`src/physics/Car.ts`, `src/physics/Traffic.ts`, `src/ai/*`) i z `PHYSICS.md`. Część uwag dotyczy rzeczy już zaimplementowanych, kilka propozycji jest fizycznie błędnych. Wdrożono trzy zmiany. Dwie wynikają z raportu (uwagi 3 i 6), trzecia uzupełnia lukę, której raport nie wskazał. Opis i kalibracja: `PHYSICS.md`, ostatnie trzy sekcje.

## Ocena uwag

| # | Uwaga | Werdykt | Uzasadnienie |
|---|---|---|---|
| 1 | Zawieszenie, prześwit quasi-statyczny | Słuszna, **wdrożono** (etapy 1–4) | Heave, pitch, przechył, stabilizatory, deska, garby poza asfaltem i morświnowanie (domyślnie wyłączone). Prześwit jest wejściem sieci. Opis i kalibracja w `PHYSICS.md`, sekcja „Zawieszenie i prześwit”. |
| 2 | Cd/Cl zależne od kąta odchylenia | Niski zysk | Kąty znoszenia F1 to kilka stopni, a opór działa już na cały wektor prędkości. Ważniejszy był brak śladu aerodynamicznego za innym autem, teraz wdrożony. |
| 3 | Rozdział sił bocznych na osie | Częściowo trafna, **wdrożono** | Osie miały już osobne Fz, koło tarcia i sztywność `22·Fz`. Brakowało wrażliwości opony na obciążenie: transfer boczny był jednolitą karą ≤8%. Teraz transfer dzieli się na osie, a tarcie koła ∝ `(Fz/Fz_śr)^−0,12`. |
| 4 | MGU-K: moment zamiast mocy | Odrzucona | MGU-K jest ograniczane mocą (350 kW), a siła na kole to P/v. Przy niskiej prędkości i tak ogranicza trakcja, więc model momentu na wale nie zmieni wyników. |
| 5 | Niska prędkość, model kinematyczny | Odrzucona | Płynne przejście 8–16 m/s jest celowe, bo kąty znoszenia przy v→0 są źle uwarunkowane. Utknięcie w żwirze już jest modelowane. |
| 6 | Kontakt: solver iteracyjny | Częściowo trafna, **wdrożono** | Iteracje już były (do 5 przejść `resolveTraffic`). Brakowało impulsu w punkcie styku i tarcia. Teraz uderzenie poza osią obraca auta, a energia nie rośnie. |
| 7 | Banda: „obciążenie aero”, żwir/asfalt | Odrzucona | Odrębne μ i opór trawy i żwiru już są, banda ma impuls z tarciem Coulomba. Obciążenie aerodynamiczne przy kontakcie z bandą nie ma podstaw fizycznych. |
| 8 | Żółta flaga: μ = 0,7 i redukcja mocy | Błędna | Flaga jest przepisem, nie zmienia przyczepności nawierzchni. Limit 22 m/s, zakaz ataku i wyprzedzania już działają. |
| 9 | Sztywne planowanie przy wrakach | Już jest | Wraki są przeszkodami w korytarzu jazdy, a omijanie i strefy żółtej flagi działają. |
| 10 | Pomyłki a DAgger | Błędne odczytanie | Pomyłki nie zmieniają docisku ani sił. Replay jest wtedy czyszczony, a DAgger uczy się z interwencji strażnika. |
| 11 | „Ghost cars” | Odrzucona | Trening już jeździ całą stawką z kolizjami. Okrążenia wspomagane ruchem są wykluczone z PB. |
| 12 | „Time dilation”, mikrokroki | Odrzucona | Stały krok 1/60 s z akumulatorem, testy przy 30/60/120 Hz, ciągły sweep kolizji. Postój nie wymaga dodatkowej precyzji. |
| 13 | Dynamiczna normalizacja wejść sieci | Szkodliwa | Stałe, fizyczne zakresy są poprawne. Skalowanie zależne od sesji zmieniałoby znaczenie wejść i unieważniało wytrenowane wagi. |
| V | Zawieszenie hydrauliczne | Wdrożono, jak pkt 1 | — |
| V | Wiatr, „induced drag”, debris | Odrzucone | Mały wpływ na wynik przy dużym koszcie. |
| V | Przegrzewanie opon | Już jest | Spadek przyczepności do 0,75 przy przegrzaniu oraz zużycie opon. |

## Wdrożone zmiany

1. **Wrażliwość opon na obciążenie** (`Car.LOAD_SENSITIVITY`). Uwaga 3.
2. **Kontakt auto–auto z obrotem i tarciem** (`Car.CONTACT_SPIN`). Uwaga 6.
3. **Zasysanie i brudne powietrze** (`Car.WAKE_AERO`, domyślnie tylko w wyścigu). Raport tego nie wskazał, a jest to główny aerodynamiczny mechanizm wyprzedzania.

Każdą zmianę można wyłączyć flagą. Testy (`npm test`, nowe przypadki w `test:traffic`) i build przechodzą. W 600 s treningu (6 ziaren) czasy okrążeń i liczba DNF mieszczą się w szumie wersji sprzed zmian.

Poprawiono też niespójność w `PHYSICS.md`: próg DNF przy kontakcie aut wynosi 12 m/s, nie 8 m/s.

## Dynamiczne zawieszenie i prześwit (uwaga 1): wdrożone 18.10.2026

Poniżej pierwotny zakres. Wszystkie etapy przeszły bramkę, wyniki są w `PHYSICS.md`.

Cel: zastąpić quasi-statyczny prześwit (`Car.ts`, blok `RIDE_HEIGHT_AERO`: ugięcie z samego docisku plus opóźnienie 0,15 s) dynamiką nadwozia. Prześwit ma zależeć od prędkości pionowej, transferu przy hamowaniu i w zakręcie oraz od tłumienia.

Zakres, etapami. Każdy etap za flagą, z kalibracją `diag:nn` (6 ziaren) przed następnym:
1. **Heave i pitch (2 DOF)**: masa resorowana, sprężyny osi (380/305 kN/m), asymetryczne tłumienie (dobicie/odbicie). Wymuszenie od docisku i transferu wzdłużnego. Wewnętrzne podkroki (4 × ~4 ms) dla stabilności. Prześwit przód/tył i kąt rake wynikają z dynamiki.
2. **Roll (3 DOF)**: stabilizatory przód/tył. Ich sztywność wyznacza podział transferu bocznego i zastępuje stałą `ROLL_STIFFNESS_FRONT = 0,52` z modelu wrażliwości opon.
3. **Dobijanie deski**: kontakt podłogi z asfaltem przy prześwicie bliskim zera, opór tarcia deski, utrata docisku. Telemetria: iskry/ostrzeżenie w HUD.
4. **Morświnowanie (opcjonalnie, domyślnie wyłączone)**: przeciągnięcie dyfuzora jako cykl graniczny. To największe ryzyko dla uczenia, bo daje chaotyczną utratę docisku.

Ryzyka i warunki przyjęcia:
- Jak przy Pacejce, nagłe zmiany docisku mogą zwiększyć liczbę rozbić. Wymagane: DNF banda/auto–auto i średni PB w szumie obecnej wersji. Planista i strażnik muszą znać bieżący prześwit.
- Koszt kroku: `npm run bench:step` nie może pogorszyć się o więcej niż ok. 15%.
- Testy: stabilność numeryczna przy 30/60/120 Hz, brak przyrostu energii w drganiach swobodnych, prześwit statyczny zgodny z `FRH_STATIC`/`RRH_STATIC`, dobicie tylko przy dużym docisku.
- Wejścia sieci mogą dostać prześwit. Zmiana liczby wejść unieważnia zapisane modele, więc trzeba zdecydować przed etapem 2.

## Audyt z 19.10.2026 (`audyt-19.10.2026.md`)

Każdy punkt porównano z kodem po zmianach z 18.10. Wdrożono pięć poprawek (A–E), żadna nie zmienia fizyki: wynik symulacji jest identyczny bit w bit z wersją sprzed poprawek.

| Pkt | Werdykt | Uzasadnienie |
|---|---|---|
| 1.1 `minCenterClearance` w metrach | Częściowo, **A: nazwane progi** | Wartość jest bezwymiarowa: odległość promienia podzielona przez szerokość toru (`· 240/76`). Skalowanie z szerokością jest celowe, bo szerszy tor widzi bandę w zakręcie dalej. Proponowane progi 1,5/3 m przy 80 m/s to 20–40 ms do bandy, czyli są szkodliwe. Magiczne liczby zastąpiono stałymi `Car.CLEAR_*` z opisem. |
| 1.2 / 5.2 NaN w `stepSuspension` | Częściowo, **B: ochrona całego stanu** | `follow = 1−e^(−4·travel)` mieści się w [0,1] przy dowolnym dt, więc clamp nie jest potrzebny. NaN skądkolwiek zostałby jednak w stanie auta na zawsze. Teraz krok z wartością nieskończoną jest odrzucany, a auto kończy jazdę jak po uderzeniu w bandę. |
| 1.3 `SUSPENSION_ROLL=false` | Błędna | Przy `false` `rollMoment = 0` (przechył zostaje zerowy), a `updatePhysics` używa statycznego `rollTransfer·ROLL_STIFFNESS_FRONT`. Wycinek z raportu (`kRollF` dla tyłu) nie odpowiada kodowi. |
| 1.4 opóźnienie transferu o krok | Słuszna, **C: udokumentowano** | 16,7 ms, świadoma decyzja. Predykcja grozi oscylacjami. |
| 1.5 morświnowanie w testach | Już jest | Przypadek w `test-suspension` i `PORPOISE=1` w `diag:nn`. |
| 1.6 limit `plankForce` 20 kN | Szkodliwa | Docisk przekracza 30 kN, więc z limitem auto przeszłoby przez asfalt. Opór deski już ogranicza `dragScale ≤ m/dt`. |
| 1.7 opór przy v≈0 | Już zabezpieczone | `m/dt` i `resistanceScale ≤ 1`. |
| 1.8–1.10 napęd przedni | Odrzucona | Bolid F1 ma napęd na tył. |
| 2.1 docisk od `speedMag` | Odrzucona | Jak pkt 2 poprzedniego audytu. |
| 2.2 / 21 DRS | Nieaktualna | Regulamin 2026 nie ma DRS. Aktywna aerodynamika jest w „Kierunku na przyszłość”. |
| 2.3 / 25 wiatr | Odrzucona | Jak w poprzednim audycie. |
| 3.1 opony na 4 koła | Poza zakresem | Duży koszt. Transfer lewo/prawo obsługuje `axleGripLoad`. |
| 3.2 temperatura toru | Opcjonalnie | Mały wpływ na trening. |
| 3.3 testy cieplne opon | Słuszna, **E: test** | Prosta, zakręt i hamowanie przy 30/60/120 Hz. Różnice 0,9 °C i 2,3% zużycia, model nie wymagał zmian. |
| 4.1 skrzynia na prędkości z początku kroku | Odrzucona | Standardowy krok jawny. |
| 4.2 moment, bezwładność kół | Odrzucona | Pkt 4 poprzedniego audytu. |
| 4.3 opóźnienie zmiany biegu | Już jest | `SHIFT_CUT` 48 ms, `SHIFT_COOLDOWN` 0,18 s. |
| 5.1 stały krok | Już jest | Akumulator z `fixedDt = 1/60` w workerze. |
| 5.3 globalny substepping | Odrzucona | Krok jest zawsze 1/60, kolizje sprawdzane są ciągłym sweepem, testy przy 30/60/120 Hz istnieją. Koszt wzrósłby ×4. |
| 6.1–6.3 alokacje w kroku | Słuszna, **D: wdrożono** | Promienie, nawierzchnia pod kołami, `currentControl` i średnie promieni bez `slice`. Krok: 537 → 465 µs (−13%). |
| 6.4–6.7 | Pomijalne | 50-elementowy `shift`, ślady poślizgu tylko przy poślizgu, trajektoria raz na 6 m. |
| 7.1 / 7.3 podział `Car.ts`, `avoidTraffic` do AI | Słuszna, **osobne zadanie** | Refaktor zrobić na zacommitowanej bazie, z kontrolą bit w bit przez `bench:step`. |
| 7.2 `PhysicsConfig` | Na teraz odrzucona | Testy i workery to osobne procesy. |
| 9.15 limity g przed zawieszeniem | Już jest | G wynikają z sił ograniczonych kołem tarcia. |
| 16–24 | Opcjonalne | Morświnowanie już jest, pozostałe mają mały wpływ na trening. |

## Kierunek na przyszłość (poza zakresem)

Aktywna aerodynamika 2026 (tryb prostej: niższe Cd i Cl na wyznaczonych odcinkach) i Manual Override (dodatkowa energia MGU-K w odległości < 1 s od rywala). Wymaga nowych wejść i wyjść sieci, więc ponownego treningu.
