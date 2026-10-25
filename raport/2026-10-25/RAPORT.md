# Audyt fizyki i zachowania bolidów

Repozytorium: `krzysztofbojko/f1simai`, commit `53f6b0b074cf81383f23c882506d68d0a1e2a29d`. Audyt: 25.10.2026.

## Ocena

Model zawiera sensowne podstawy symulacji: siły w jednostkach SI, koła tarcia osi, dynamiczny model jednośladu, transfer obciążeń, zawieszenie, termikę opon i hamulców oraz ciągłą detekcję kontaktów. Testy pokazują, że AI potrafi jechać, kończyć okrążenia, wyprzedzać i reagować na zagrożenia. Nie dowodzą jednak zgodności modelu z prawdziwym bolidem F1. Znalazłem cztery problemy w fizyce i logice zachowania oraz dodatkowy problem z losowością.

Kod aplikacji pozostał bez zmian. Reprodukcje i wyniki są obok raportu. Priorytety opisują wpływ na symulację, nie bezpieczeństwo informatyczne.

## 1. Wysoki: odzysk ERS bez spójnego bilansu energii

Źródło: `src/physics/Car.ts:1589`, szczególnie 1592–1596; siły napędu i oporów: 1522–1526 oraz 1606–1607.

Lift-and-coast dopisuje 105 kW × 88% do baterii, bez zależnego od tej mocy momentu hamującego. Moc odzysku nie jest też ograniczana dostępną pracą hamowania silnikiem. W porównaniu dwóch identycznych przejazdów z 60 m/s przez sekundę auto z dostępnym budżetem odzysku dostało **92,4 kJ**, a auto z wyczerpanym budżetem **0 kJ**. Oba osiągnęły dokładnie **55,5233745786 m/s** i **57,5908241913 m** drogi.

Silniejszy test: pusty bak, początkowo 31 m/s, bieg 6 i 5000 obr./min, bez gazu i hamulca, 0,1 s. Energia kinetyczna zmalała o **6117,71 J**, bateria zyskała **9240 J**. Suma energii translacyjnej i baterii wzrosła o **3122,29 J**, mimo braku napędu i obecności oporów. To izolowany scenariusz fizyki, a nie pomiar częstości zdarzenia w wyścigu.

Skutek: zawyżona opłacalność odpuszczania gazu, stan baterii i dostępna później moc. Przy hamowaniu dodatkowo odzysk liczony jest z sumy obu osi, choć MGU-K działa na tylnej; odejmowanie tej mocy wyłącznie od nagrzewania tylnych hamulców wymaga osobnego uporządkowania bilansu.

Naprawa: jeden wspólny rachunek momentu tylnej osi, mocy generatora, energii baterii i ciepła. Ograniczyć odzysk przyczepnością, rzeczywistą pracą tylnej osi, pojemnością i budżetem; przy coast uwzględnić odpowiadającą odzyskowi siłę hamującą. Testować bilans energii także z pustym bakiem i przy osiąganiu limitów baterii.

## 2. Wysoki: nieciągłość docisku przy zerowym wietrze

Źródło: `src/physics/Car.ts:1462`, zwłaszcza warunek `windy` w 1466.

Utrata docisku od kąta napływu powietrza działa wyłącznie, gdy wiatr ma niezerową składową. W bezwietrznej pogodzie bolid jadący bokiem dostaje pełny docisk zależny od modułu prędkości, choć przepływ jest poprzeczny do nadwozia.

Reprodukcja: bolid ustawiony wzdłuż X, porusza się z prędkością 60 m/s wzdłuż Y. Suma sił aero przekazanych do zawieszenia wynosi **6225,92 N** przy zerowym wietrze, ale **2490,37 N** przy wietrze X = **10⁻¹² m/s**. Praktycznie niezmienione warunki dają spadek o **60%**.

Skutek: zawyżona przyczepność podczas dużego poślizgu w bezwietrznej pogodzie i odmienne wychodzenie z obrotu zależnie od samego faktu włączenia wiatru.

Naprawa: wyznaczać kąt napływu zawsze z prędkości względnej powietrza, niezależnie od `windy`. Dodać test ciągłości wokół zera wiatru i różnych kątów poślizgu.

## 3. Średni: brak rzutu siły skręconej przedniej osi

Źródło: `src/physics/Car.ts:1651`, 1657, 1661, 1666 oraz 1699.

Kąt poślizgu przedniej osi uwzględnia skręt kół, ale wynikowa siła jest traktowana w całości jako poprzeczna do nadwozia. Brakuje transformacji sił koła do układu auta: dla samej siły bocznej powinny wystąpić składowe `-Fy*sin(delta)` i `Fy*cos(delta)`, a także odpowiednia transformacja siły wzdłużnej. Moment yaw również powinien wynikać z tych składowych.

Reprodukcja przy 60 m/s i ustalonym skręcie kół 0,25 rad: przednia siła boczna to **9435,13 N**. Pominięta składowa wzdłużna wynosiłaby około **−2334,29 N**. Po pierwszym kroku prędkość X jest identyczna przy kołach prostych i skręconych: **59,9128175229 m/s**.

To istotne uproszczenie modelu, szczególnie przy dużym skręcie. Zaburza straty prędkości w zakręcie, yaw i sprzężenie hamowania ze skrętem. Nie wyznaczałem procentowego wpływu na czas pełnego okrążenia. Dla małych kątów błąd jest mniejszy.

Naprawa: spójna transformacja całego wektora sił przedniej osi i ponowna kalibracja planisty oraz AI; test kołowy i bilans pracy sił dla różnych kątów.

## 4. Średni: eliminacja za brak postępu zależy od częstotliwości fizyki

Źródło: `src/physics/Car.ts:1423`, `src/physics/LapTiming.ts:57` i 103.

Licznik rośnie o jeden na krok, a eliminacja następuje po przekroczeniu 600 klatek (1800 w określonym stanie odzyskiwania kontroli). Reprodukcja zatrzymanego auta daje zawsze 601 kroków:

| Częstotliwość | Czas do eliminacji `stuck` |
|---|---:|
| 30 Hz | 20,033 s |
| 60 Hz | 10,017 s |
| 120 Hz | 5,008 s |

Podobnie próg 30 klatek przy odzyskiwaniu checkpointu zmienia rzeczywisty czas działania. Produkcyjny worker domyślnie używa 60 Hz, więc nie jest to dowód zależności od FPS renderowania. Problem narusza natomiast deklarowaną porównywalność zachowania przy 30/60/120 Hz i utrudnia zmianę kroku.

Naprawa: liczniki czasu w sekundach, aktualizowane przez `dt`, z testem identycznych terminów eliminacji i odzyskiwania postępu.

## 5. Średni: ślady opon zużywają wspólną losowość symulacji

Źródło: `src/physics/Car.ts:1692`, `src/math/Random.ts:11` i 24.

Losowanie rysowania śladów opon korzysta z tego samego `random()` co zachowanie symulacji. W sekundzie izolowanej jazdy bokiem liczba pobrań wyniosła odpowiednio **30, 60 i 120** przy tych częstotliwościach. Prawdopodobieństwo śladu 0,28 jest określone na krok, a nie jednostkę czasu.

Skutek: kosmetyczna zmiana śladów może przesunąć strumień losowań dla późniejszych zdarzeń AI. Ten sam seed i niezmieniona konfiguracja nadal pozostają powtarzalne; problem dotyczy sprzężenia efektów wizualnych z zachowaniem oraz porównań między krokami czasu. Nie zmierzyłem zmiany częstości wypadków powodowanej wyłącznie tym sprzężeniem.

Naprawa: osobny generator dla efektów wizualnych i próbkowanie śladów według czasu lub przebytej drogi.

## Pozostałe ograniczenia modelu

- Nawierzchnia pod czterema kołami jest uśredniana do jednego współczynnika tarcia (`Car.ts:1511`, 1820). Nie odwzorowuje asymetrii przyczepności lewo/prawo ani różnicy przód/tył podczas przekraczania krawędzi asfaltu. To opisane uproszczenie, ale istotne przy analizie wyjazdów na trawę.
- Jazda w pit lane korzysta z własnej kinematyki (`PitStrategy.ts:199`), a nie pełnego solvera opon i napędu. Przejazd aleją nie waliduje zachowania fizycznego na torze.
- Model ogranicza napęd na podstawie dostępnej trakcji i rezerwuje siłę boczną (`Car.ts:1528`). To automatyczna stabilizacja. Nie należy interpretować dobrych wyjść z zakrętów jako dowodu, że sama sieć AI nauczyła się dozować gaz na granicy poślizgu.
- Nie wykonano kalibracji względem telemetrii konkretnego bolidu, sezonu, mieszanki ani toru. Czasy 0–100 czy pojedynczego okrążenia nie wystarczają do potwierdzenia realizmu całego modelu.

## Weryfikacja

W tym audycie wykonano:

- `node scripts/audit-physics.mjs`: zakończenie poprawne; próbki sił i hamowania, brak obrotu bez przyczepności, hamowanie do spoczynku oraz 300 s treningu GP. Najlepsze okrążenie 53,0468 s, 10 aktywnych aut, generacja 4. Tryb pomiarowy, bez flagi `--test`.
- `npm run test:suspension`: passed; także kontrolowane odzyskanie po NaN. Komunikat o wycofaniu auta stanowi część tego testu.
- `npm run test:traffic`: passed; kontakty ciągłe, rozdzielanie, energia zderzeń, rzeczywiste wyprzedzanie i hamowanie AI.
- `npm run test:weather`: passed; wiatr, temperatura opon i hamulców. Prędkości maksymalne w testach: 288/308/328 km/h dla wiatru czołowego/braku wiatru/tylnego 8 m/s.
- Własny `probes.mjs`: reprodukcje opisanych przypadków, wyniki w `results.json`.

Pełny `npm test` przeszedł wcześniej podczas konfiguracji tego samego commita; nie uruchamiałem go ponownie w całości. Testy regresyjne mogą przechodzić równolegle z opisanymi wadami, ponieważ nie obejmują ich warunków brzegowych. Nie wykonano audytu wizualnego WebGL ani długiego testu wszystkich torów.

Reprodukcja własnych prób: `node raport/2026-10-25/probes.mjs` (z katalogu głównego repozytorium, po `npm ci`). Używają nieograniczonej płaskiej nawierzchni, izolowanych stanów wejściowych i deterministycznego inicjowania. Bundlowanie nie modyfikuje źródeł aplikacji.

## Zalecana kolejność

Najpierw bilans ERS i ciągłość aero. Następnie transformacja sił przedniej osi, liczniki czasu i izolacja RNG. Po zmianach fizyki ponownie zmierzyć hamowanie, przyspieszenie, jazdę po okręgu, zachowanie przy poślizgu, bilans energii i zgodność 30/60/120 Hz. Dopiero potem kalibrować tempo AI i porównywać czasy okrążeń na wielu ziarnach; wcześniejsze modele AI mogą wymagać ponownego treningu.
